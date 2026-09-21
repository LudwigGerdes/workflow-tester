/**
 * Vendor ingestion — the only networked code in workflow-tester.
 *
 * Lives in `src` rather than `scripts` so `workflow-tester contracts update --fetch` can
 * call it directly; `scripts/ingest.ts` is a thin wrapper over the same
 * functions. Nothing here runs unless a user explicitly asks to fetch.
 *
 * Fetches each vendor's published spec into the cache (~/.workflow-tester/vendor-specs),
 * normalises its webhook definitions into a committed per-vendor catalog, and
 * regenerates AUDIT.md.
 * Nothing at runtime calls this; `workflow-tester contracts update --fetch` does.
 *
 *   pnpm ingest [--vendor <name>] [--refetch] [--offline]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import AjvModule from 'ajv';
import { parse } from 'yaml';
import { dataDir } from 'workflow-tester-paths';
import type { Catalog, CatalogEvent, Sources, VendorSource } from './types.js';

/** `packages/vendors` in a checkout, `data/vendors` inside the installed package. */
const PACKAGE_DIR = dataDir('vendors');
const DATA_DIR = join(PACKAGE_DIR, 'data');

/**
 * Where fetched vendor specs are cached, so the same spec bytes are not
 * fetched twice.
 *
 * `WORKFLOW_TESTER_CACHE`, not `WORKFLOW_TESTER_HOME` — the latter already names the workflow-tester
 * checkout for `scripts/workflow-tester.sh`.
 */
export function cacheRootFor(env: Record<string, string | undefined> = process.env): string {
  return join(env['WORKFLOW_TESTER_CACHE'] ?? join(homedir(), '.workflow-tester'), 'vendor-specs');
}

const CACHE_ROOT = cacheRootFor();

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Read a dotted path, e.g. `paths./v1/x.post.responses`. */
function at(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const segment of path.split('.')) {
    if (!isObject(node)) return undefined;
    node = node[segment];
  }
  return node;
}

/**
 * Resolve every `#/components/schemas/...` reference into a self-contained
 * schema.
 *
 * Written by hand rather than pulled from a ref-parser because these specs are
 * cyclic (a GitHub repository references its owner, which references
 * repositories). A dereferencer that returns live object graphs cannot be
 * serialised to JSON; here a reference that reappears on its own resolution
 * stack degrades to a permissive object and the result is always finite.
 */
function inlineRefs(node: unknown, components: Json, stack: string[]): unknown {
  if (Array.isArray(node)) return node.map((entry) => inlineRefs(entry, components, stack));
  if (!isObject(node)) return node;

  const ref = node.$ref;
  if (typeof ref === 'string') {
    const name = ref.startsWith('#/components/schemas/')
      ? ref.slice('#/components/schemas/'.length)
      : undefined;
    if (name === undefined) {
      return { description: `unresolvable reference ${ref}` };
    }
    if (stack.includes(name)) {
      return { type: 'object', description: `circular reference to ${name}` };
    }
    const target = components[name];
    if (target === undefined) {
      return { description: `missing schema ${name}` };
    }
    return inlineRefs(target, components, [...stack, name]);
  }

  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = inlineRefs(value, components, stack);
  }
  return out;
}

/**
 * Collect whatever example payloads a media-type object carries.
 *
 * Examples are frequently `$ref`s into `components/examples` (GitHub keeps 536
 * of them there), and each entry wraps the payload in a `value`. Both are
 * resolved here so the catalog holds real payloads rather than pointers — the
 * generator anchors its mutations to these, so an unresolved reference would be
 * worse than no example at all.
 */
function examplesOf(mediaType: unknown, spec: Json): unknown[] {
  if (!isObject(mediaType)) return [];
  const store = (at(spec, 'components.examples') ?? {}) as Json;

  const resolve = (entry: unknown): unknown => {
    let node = entry;
    if (isObject(node) && typeof node.$ref === 'string') {
      const prefix = '#/components/examples/';
      if (!node.$ref.startsWith(prefix)) return undefined;
      node = store[node.$ref.slice(prefix.length)];
    }
    if (isObject(node) && 'value' in node) return node.value;
    return node;
  };

  const found: unknown[] = [];
  const push = (value: unknown): void => {
    if (value !== undefined) found.push(value);
  };

  push(resolve(mediaType.example));
  if (isObject(mediaType.examples)) {
    for (const entry of Object.values(mediaType.examples)) push(resolve(entry));
  }
  return found;
}

/**
 * Where a vendor publishes the example payload for one operation.
 *
 * GitHub's operationIds are `push` or `pull-request/closed`; octokit's files are
 * `push/1.payload.json` and `pull_request/closed.payload.json`. An event with no
 * action is numbered rather than named.
 */
function examplePathFor(operationId: string): string {
  const [rawEvent, action] = operationId.split('/');
  const event = (rawEvent ?? '').replace(/-/g, '_');
  return action === undefined ? `${event}/1.payload.json` : `${event}/${action}.payload.json`;
}

/**
 * Fetch the published example for one event, caching the bytes in the shared
 * suite cache so a re-ingest is offline. A vendor that publishes no example for
 * an event returns nothing — that is a fact about the vendor, not a failure.
 */
async function fetchExample(
  vendor: string,
  baseUrl: string,
  operationId: string,
  offline: boolean,
): Promise<unknown | undefined> {
  const relative = examplePathFor(operationId);
  const file = join(CACHE_ROOT, vendor, 'examples', relative);

  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    return text.length === 0 ? undefined : (JSON.parse(text) as unknown);
  }
  if (offline) return undefined;

  const response = await fetch(`${baseUrl}/${relative}`);
  mkdirSync(dirname(file), { recursive: true });

  if (!response.ok) {
    // Remember the absence too, so the next run does not ask again.
    writeFileSync(file, '');
    return undefined;
  }
  const text = await response.text();
  writeFileSync(file, text);
  return JSON.parse(text) as unknown;
}

interface FetchedSpec {
  spec: Json;
  sha256: string;
  specVersion: string;
  fromCache: boolean;
}

/** Newest cached version directory for a vendor, if any. */
function cachedVersions(vendor: string): string[] {
  const dir = join(CACHE_ROOT, vendor);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'spec.json')))
    .map((e) => e.name)
    .sort();
}

async function loadSpec(
  vendor: string,
  source: VendorSource,
  options: { refetch: boolean; offline: boolean },
): Promise<FetchedSpec> {
  const existing = cachedVersions(vendor);
  if (!options.refetch && existing.length > 0) {
    const version = existing[existing.length - 1] as string;
    const bytes = readFileSync(join(CACHE_ROOT, vendor, version, 'spec.json'));
    return {
      spec: JSON.parse(bytes.toString('utf8')) as Json,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      specVersion: version,
      fromCache: true,
    };
  }
  if (options.offline) throw new Error(`${vendor}: nothing cached and --offline was given`);
  if (source.specUrl === undefined) throw new Error(`${vendor}: no specUrl`);

  process.stdout.write(`  fetching ${source.specUrl}\n`);
  const response = await fetch(source.specUrl);
  if (!response.ok) {
    throw new Error(
      `${vendor}: ${source.specUrl} returned ${response.status}. Find the current canonical ` +
        'location, update sources.yaml, and note the move in the commit.',
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const spec = JSON.parse(bytes.toString('utf8')) as Json;
  const specVersion = String(at(spec, source.versionFrom ?? 'info.version') ?? 'unknown');

  const dir = join(CACHE_ROOT, vendor, specVersion);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.json'), bytes);

  return { spec, sha256: createHash('sha256').update(bytes).digest('hex'), specVersion, fromCache: false };
}

/** GitHub-style: one operation per event under `x-webhooks` (or 3.1 `webhooks`). */
function fromWebhookOperations(
  spec: Json,
  key: 'x-webhooks' | 'webhooks',
  source: VendorSource,
  vendor: string,
  specVersion: string,
  sha256: string,
): { available: string[]; events: Record<string, CatalogEvent> } {
  const webhooks = isObject(spec[key]) ? (spec[key] as Json) : {};
  const components = (at(spec, 'components.schemas') ?? {}) as Json;
  const available = Object.keys(webhooks).sort();
  const wanted = source.events ?? available;
  const events: Record<string, CatalogEvent> = {};

  for (const event of wanted) {
    const operation = at(webhooks, `${event}.post`);
    if (!isObject(operation)) {
      throw new Error(`${vendor}: no ${key} entry "${event}" (have ${available.length} events)`);
    }
    const mediaType = at(operation, 'requestBody.content.application/json');
    const schema = isObject(mediaType) ? mediaType.schema : undefined;
    // operationId splits the header event from the action: `pull-request/closed`
    const operationId = String(operation.operationId ?? event);
    const headerValue = operationId.split('/')[0]?.replace(/-/g, '_');

    events[event] = {
      schema: inlineRefs(schema, components, []),
      examples: examplesOf(mediaType, spec),
      provenance: {
        vendor,
        event,
        specVersion,
        sourceUrl: source.specUrl ?? '',
        sha256,
        derived: false,
        eventHeaderValue: headerValue,
        operationId,
      },
    };
  }
  return { available, events };
}

/** Stripe-style: a single envelope schema plus an enumerated list of event names. */
function fromStripeEvents(
  spec: Json,
  source: VendorSource,
  vendor: string,
  specVersion: string,
  sha256: string,
): { available: string[]; events: Record<string, CatalogEvent> } {
  const components = (at(spec, 'components.schemas') ?? {}) as Json;
  const envelope = components[source.envelopeSchema ?? 'event'];
  if (envelope === undefined) throw new Error(`${vendor}: no "${source.envelopeSchema}" schema`);

  const enumerated = source.eventEnumPath === undefined ? undefined : at(spec, source.eventEnumPath);
  const available = (Array.isArray(enumerated) ? enumerated : [])
    .filter((v): v is string => typeof v === 'string' && v !== '*')
    .sort();

  const inlined = inlineRefs(envelope, components, []) as Json;
  const events: Record<string, CatalogEvent> = {};

  for (const event of source.events ?? available) {
    if (available.length > 0 && !available.includes(event)) {
      throw new Error(`${vendor}: "${event}" is not in the published event list`);
    }
    // Narrow only what the spec actually states: the discriminating `type`.
    // `data.object` stays the generic union — Stripe does not type it per event.
    const schema = structuredClone(inlined);
    const properties = isObject(schema.properties) ? schema.properties : {};
    schema.properties = { ...properties, type: { type: 'string', const: event } };

    events[event] = {
      schema,
      examples: [],
      provenance: {
        vendor,
        event,
        specVersion,
        sourceUrl: source.specUrl ?? '',
        sha256,
        derived: false,
        caveats: [
          'data.object is the generic Stripe object union: the spec does not type it per event',
        ],
      },
    };
  }
  return { available, events };
}

export async function ingestVendor(vendor: string, source: VendorSource, options: { refetch: boolean; offline: boolean }): Promise<Catalog | undefined> {
  process.stdout.write(`\n${vendor} (${source.kind})\n`);
  if (source.kind === 'none') {
    process.stdout.write('  no machine-readable source — recorded in AUDIT.md\n');
    return undefined;
  }

  const { spec, sha256, specVersion, fromCache } = await loadSpec(vendor, source, options);
  process.stdout.write(`  spec ${specVersion} (${fromCache ? 'cached' : 'fetched'}) sha256 ${sha256.slice(0, 12)}\n`);

  const built =
    source.kind === 'stripe-events'
      ? fromStripeEvents(spec, source, vendor, specVersion, sha256)
      : fromWebhookOperations(
          spec,
          source.kind === 'openapi-webhooks' ? 'webhooks' : 'x-webhooks',
          source,
          vendor,
          specVersion,
          sha256,
        );

  // Fill in examples the spec itself does not link, from wherever the vendor
  // publishes them. Done after normalisation so it applies to every kind.
  if (source.examplesBaseUrl !== undefined) {
    for (const [event, entry] of Object.entries(built.events)) {
      if (entry.examples.length > 0) continue;
      const operationId = entry.provenance.operationId ?? event;
      const example = await fetchExample(vendor, source.examplesBaseUrl, operationId, options.offline);
      if (example !== undefined) {
        entry.examples.push(example);
        entry.provenance.examplesUrl = `${source.examplesBaseUrl}/${examplePathFor(operationId)}`;
      }
    }
    const found = Object.values(built.events).filter((e) => e.examples.length > 0).length;
    process.stdout.write(`  ${found}/${Object.keys(built.events).length} events have an example payload\n`);
  }

  // Validate every published example against the schema we derived for it. This
  // is as much a check on the inliner as on the vendor: a schema that lost a
  // required subtree while being flattened shows up here as a failing example.
  const exampleWarnings = validateExamples(built.events);

  const catalog: Catalog = {
    vendor,
    specVersion,
    generatedAt: new Date().toISOString(),
    kind: source.kind,
    availableEvents: built.available,
    events: built.events,
    exampleWarnings,
  };

  const outDir = join(DATA_DIR, vendor, specVersion);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, 'catalog.json');
  const json = `${JSON.stringify(catalog, null, 2)}\n`;

  // Write only when something other than the timestamp moved. Re-ingesting
  // unchanged bytes must produce no diff at all: otherwise every run dirties
  // the tree and a real change is lost in the noise.
  if (existsSync(file)) {
    const previous = JSON.parse(readFileSync(file, 'utf8')) as Catalog;
    if (JSON.stringify({ ...previous, generatedAt: '' }) === JSON.stringify({ ...catalog, generatedAt: '' })) {
      process.stdout.write(`  unchanged (${Object.keys(built.events).length} events)\n`);
      return previous;
    }
  }
  writeFileSync(file, json);
  process.stdout.write(
    `  ${Object.keys(built.events).length}/${built.available.length} events -> ${(json.length / 1024).toFixed(0)} KB\n`,
  );
  return catalog;
}

/**
 * A copy of a schema that ajv will actually compile.
 *
 * These are OpenAPI 3.0 documents, where `nullable: true` is a vendor keyword
 * rather than JSON Schema; ajv rejects it outright with "nullable cannot be used
 * without type", so a schema carrying it silently never validated anything. The
 * keyword is translated into the JSON Schema equivalent for validation only —
 * the catalog keeps `nullable` as published, because the generator reads it to
 * decide where a `nullable-null` mutation belongs.
 */
function forValidation(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(forValidation);
  if (!isObject(node)) return node;

  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'nullable') continue;
    out[key] = forValidation(value);
  }
  if (node.nullable === true && out.type !== undefined) {
    out.type = Array.isArray(out.type) ? [...out.type, 'null'] : [out.type, 'null'];
  }
  return out;
}

/**
 * Check each example against its own schema. Failures are recorded, never
 * dropped: a real payload that disagrees with the published schema is a fact
 * about the vendor worth surfacing, not a reason to discard the payload.
 */
function validateExamples(events: Record<string, CatalogEvent>): string[] {
  // ajv v8 is CJS: under NodeNext its class arrives either as the module itself
  // or under `.default`, depending on how the loader interops it. This picks
  // whichever is actually constructable instead of guessing.
  const Ajv = ((AjvModule as unknown as { default?: typeof AjvModule }).default ??
    AjvModule) as unknown as new (options: Record<string, unknown>) => {
    compile: (schema: object) => ((data: unknown) => boolean) & {
      errors?: Array<{ instancePath?: string; message?: string }> | null;
    };
  };
  const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
  const warnings: string[] = [];

  for (const [event, entry] of Object.entries(events)) {
    if (entry.examples.length === 0) continue;
    let validate;
    try {
      validate = ajv.compile(forValidation(entry.schema) as object);
    } catch (error) {
      warnings.push(`${event}: schema did not compile — ${(error as Error).message}`);
      continue;
    }
    entry.examples.forEach((example, index) => {
      if (!validate(example)) {
        const first = validate.errors?.[0];
        warnings.push(
          `${event}: example ${index} does not validate — ${first?.instancePath || '/'} ${first?.message ?? ''}`.trim(),
        );
      }
    });
  }
  return warnings;
}

export function writeAudit(sources: Sources, catalogs: Map<string, Catalog>): void {
  const coverage = (kind: string): string =>
    kind === 'none' ? 'nothing' : kind === 'examples-only' ? 'examples only' : 'schema';

  const rows = Object.entries(sources.vendors).map(([vendor, source]) => {
    const catalog = catalogs.get(vendor);
    const events = catalog === undefined ? '—' : `${Object.keys(catalog.events).length} of ${catalog.availableEvents.length}`;
    const examples =
      catalog === undefined
        ? '—'
        : String(Object.values(catalog.events).reduce((n, e) => n + e.examples.length, 0));
    const notes = (source.notes ?? '').replace(/\s+/g, ' ').trim();
    return `| ${vendor} | ${coverage(source.kind)} | \`${source.kind}\` | ${catalog?.specVersion ?? '—'} | ${events} | ${examples} | ${notes} |`;
  });

  const findings = [...catalogs.values()].flatMap((c) =>
    c.exampleWarnings.map((w) => `- \`${c.vendor}\` ${w}`),
  );
  const validationSection =
    findings.length === 0 ? 'No disagreements found.' : findings.join('\n');

  const body = `# Vendor coverage audit

Generated by \`pnpm ingest\`. Do not edit by hand.

Coverage is the honest answer to "what does this vendor actually publish?":
**schema** (machine-readable payload schemas), **examples only** (payloads but no
schema, so one is derived), or **nothing**.

| vendor | coverage | kind | spec version | events materialised | examples | notes |
|---|---|---|---|---|---|---|
${rows.join('\n')}

## Known gaps

- **Stripe publishes no example payloads.** GitHub's are now complete — every
  curated event has a real payload, taken from octokit's published set, since
  GitHub's own REST description links one on just 6 of its 270 webhook
  operations and on none of push, pull_request or issues. Stripe has no
  equivalent source, so its \`oneOf\` branches are still synthesised, and spec §4
  anchors every mutation to a payload someone actually sent. Finding a source for
  Stripe is the remaining gap of this kind.
- **Stripe \`data.object\` is untyped per event.** The spec carries one \`event\`
  envelope whose \`data.object\` is the generic object union; only \`type\` is
  narrowed, to a \`const\`. Per-event object typing is not derivable from the
  published spec, which is the fallback the phase-1 plan allows.
- **A vendor's own examples do not always satisfy its own schema.** Validation
  findings are listed under "Example validation" below; they are recorded, never
  dropped. A published payload that disagrees with the published schema is a
  fact about the vendor, and the payload is the more trustworthy of the two.
- **Slack has no machine-readable source.** Its OpenAPI document covers the Web
  API; Events API payload shapes live in prose documentation only.

## Example validation

Every published example checked against the schema derived for it.

${validationSection}
`;
  writeFileSync(join(PACKAGE_DIR, 'AUDIT.md'), body);
}

export interface IngestOptions {
  refetch?: boolean;
  offline?: boolean;
}

/** Ingest one vendor or all of them, then regenerate AUDIT.md. */
export async function ingestAll(
  only?: string,
  options: IngestOptions = {},
): Promise<Map<string, Catalog>> {
  const resolved = { refetch: options.refetch ?? false, offline: options.offline ?? false };
  const sources = parse(readFileSync(join(PACKAGE_DIR, 'sources.yaml'), 'utf8')) as Sources;

  if (only !== undefined && sources.vendors[only] === undefined) {
    throw new Error(`unknown vendor "${only}" (known: ${Object.keys(sources.vendors).join(', ')})`);
  }

  const catalogs = new Map<string, Catalog>();
  for (const [vendor, source] of Object.entries(sources.vendors)) {
    if (only !== undefined && only !== vendor) continue;
    const catalog = await ingestVendor(vendor, source, resolved);
    if (catalog !== undefined) catalogs.set(vendor, catalog);
  }

  // AUDIT.md always reflects every vendor, so a single-vendor run needs the rest.
  if (only !== undefined) {
    for (const vendor of Object.keys(sources.vendors)) {
      if (catalogs.has(vendor) || sources.vendors[vendor]?.kind === 'none') continue;
      try {
        const dir = join(DATA_DIR, vendor);
        const versions = readdirSync(dir).sort();
        const latest = versions.at(-1);
        if (latest !== undefined) {
          catalogs.set(vendor, JSON.parse(readFileSync(join(dir, latest, 'catalog.json'), 'utf8')) as Catalog);
        }
      } catch {
        // no committed catalog for this vendor yet; the audit will show a dash
      }
    }
  }

  writeAudit(sources, catalogs);
  return catalogs;
}
