import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv';
import type { Catalog } from 'workflow-tester-vendors';
import { parseDocument, parse as parseYaml } from 'yaml';
import type { Contract, SchemaSource, VendorSource } from './types.js';

// ajv's ESM build exports the class as `default`; under some loaders that is
// itself the module namespace. Same dance as the generator's schema walk.
type AjvLike = new (options: Record<string, unknown>) => { compile: (schema: object) => ValidateFunction };
const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as AjvLike;

/** Annotation naming the event a oneOf branch belongs to. */
export const EVENT_KEY = 'x-workflow-tester-event';
/** Annotation carrying the value the vendor sends in its event header. */
export const EVENT_HEADER_KEY = 'x-workflow-tester-event-header';

export interface MaterializeOptions {
  /** Where the shape files go, e.g. `<repo>/.workflow-tester/contracts`. */
  outDir: string;
  /** Directory the contract lives in; shape paths are written relative to it. */
  contractDir: string;
  /** The contract file to update in place. */
  contractFile: string;
}

export interface MaterializeResult {
  shape: Contract['shape'];
  specVersion: string;
  events: string[];
  warnings: string[];
}

/** An example payload, kept with the event that published it. */
export interface TaggedExample {
  event: string;
  payload: unknown;
}

/** Sort keys everywhere so a regenerated file is byte-identical to the last one. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return Object.fromEntries(entries.map(([k, v]) => [k, stable(v)]));
}

const write = async (file: string, value: unknown): Promise<void> => {
  await writeFile(file, `${JSON.stringify(stable(value), null, 2)}\n`);
};

/**
 * A short, stable, filesystem-safe name for a set of events: the event itself
 * when there is one, their shared prefix when they have one (`invoice.paid` and
 * `invoice.payment_failed` become `invoice`), and a hash otherwise.
 */
export function slugFor(events: string[]): string {
  const safe = events.map((e) => e.replace(/[^A-Za-z0-9._-]/g, '-'));
  if (safe.length === 1) return safe[0] as string;

  const heads = safe.map((e) => e.split('.')[0]);
  const [first] = heads;
  if (first !== undefined && heads.every((h) => h === first)) return first;

  const digest = createHash('sha256').update([...safe].sort().join('\n')).digest('hex');
  return `multi-${digest.slice(0, 8)}`;
}

/**
 * Resolve a contract's `source` against a vendor catalog and commit the result:
 * one JSON Schema and one example set, both pinned to a spec version, so every
 * later run is offline and reproducible.
 */
export async function materialize(
  contract: Contract,
  catalog: Catalog,
  options: MaterializeOptions,
): Promise<MaterializeResult> {
  if (contract.source.kind !== 'vendor') {
    throw new Error(`materialize: a ${contract.source.kind} source takes no catalog; use materializeSchema`);
  }
  const source: VendorSource = contract.source;
  const only = contract.overrides?.only;
  const requested =
    only === undefined || only.length === 0
      ? source.events
      : source.events.filter((event) => only.includes(event));

  const warnings: string[] = [];
  const branches: Array<Record<string, unknown>> = [];
  const examples: TaggedExample[] = [];

  for (const event of requested) {
    const entry = catalog.events[event];
    if (entry === undefined) {
      const available = Object.keys(catalog.events).sort();
      throw new Error(
        `${catalog.vendor} has no materialised event "${event}".\n` +
          `  available: ${available.join(', ')}\n` +
          (catalog.availableEvents.includes(event)
            ? `  "${event}" is published but not in the curated set — add it to sources.yaml and re-run \`pnpm ingest\`.`
            : `  it is not among the ${catalog.availableEvents.length} events ${catalog.vendor} publishes.`),
      );
    }

    const schema = entry.schema as Record<string, unknown>;
    const header = entry.provenance.eventHeaderValue;
    branches.push({
      ...schema,
      [EVENT_KEY]: event,
      ...(header === undefined ? {} : { [EVENT_HEADER_KEY]: header }),
    });

    if (entry.examples.length === 0) {
      warnings.push(
        `${catalog.vendor}/${event}: no example payload published; generated cases will have to synthesise one`,
      );
    }
    for (const payload of entry.examples) examples.push({ event, payload });
  }

  if (branches.length === 0) {
    throw new Error(`contract selects no events (source.events ∩ overrides.only is empty)`);
  }

  // A single event needs no oneOf: the branch is the shape.
  const schema = branches.length === 1 ? (branches[0] as Record<string, unknown>) : { oneOf: branches };
  const shape = await commitShape(`${catalog.vendor}.${slugFor(requested)}`, schema, examples, options);
  return { shape, specVersion: catalog.specVersion, events: requested, warnings };
}

/** Write the shape files and point the contract's `shape` block at them. */
async function commitShape(
  base: string,
  schema: unknown,
  examples: TaggedExample[],
  options: MaterializeOptions,
): Promise<NonNullable<Contract['shape']>> {
  await mkdir(options.outDir, { recursive: true });
  const schemaFile = join(options.outDir, `${base}.schema.json`);
  const examplesFile = join(options.outDir, `${base}.examples.json`);
  await write(schemaFile, schema);
  await write(examplesFile, examples);

  const shape = {
    schema: relative(options.contractDir, schemaFile),
    examples: relative(options.contractDir, examplesFile),
  };

  // Rewrite only the `shape` block, through the YAML document, so comments and
  // formatting elsewhere in the user's file survive.
  const text = await readFile(options.contractFile, 'utf8');
  const doc = parseDocument(text);
  doc.set('shape', shape);
  const updated = doc.toString();
  if (updated !== text) await writeFile(options.contractFile, updated);
  return shape;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Parse a `.json`, `.yaml` or `.yml` file, naming it in any error. */
async function readData(file: string, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new Error(`${what}: no such file ${file}`);
  }
  try {
    return /\.ya?ml$/.test(file) ? (parseYaml(text) as unknown) : (JSON.parse(text) as unknown);
  } catch (error) {
    throw new Error(`${what}: ${file} does not parse: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Example payloads from a directory of `.json` files or one file holding one or a list. */
async function readExamples(path: string): Promise<Array<{ file: string; payload: unknown }>> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`source.examples: no such file or directory ${path}`);
  }
  if (info.isDirectory()) {
    const names = (await readdir(path)).filter((n) => n.endsWith('.json')).sort();
    const out: Array<{ file: string; payload: unknown }> = [];
    for (const name of names) {
      const file = join(path, name);
      out.push({ file, payload: await readData(file, 'source.examples') });
    }
    return out;
  }
  const data = await readData(path, 'source.examples');
  return Array.isArray(data)
    ? data.map((payload, i) => ({ file: `${path}[${i}]`, payload }))
    : [{ file: path, payload: data }];
}

/**
 * Materialise a contract whose shape is a JSON Schema the user owns: the
 * schema is copied into the shape (so a later edit to the source shows up as
 * drift, like a vendor spec bump), the examples are validated against it and
 * kept beside it. `specVersion` is a digest of the schema file, which is the
 * pin an audit asks for.
 */
export async function materializeSchema(
  contract: Contract,
  options: MaterializeOptions,
): Promise<MaterializeResult> {
  if (contract.source.kind !== 'schema') {
    throw new Error(`materializeSchema: a ${contract.source.kind} source needs a catalog; use materialize`);
  }
  const source: SchemaSource = contract.source;
  const schemaFile = resolve(options.contractDir, source.schema);
  const schema = await readData(schemaFile, 'source.schema');
  if (!isRecord(schema)) throw new Error(`source.schema: ${schemaFile} is not a JSON Schema object`);

  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new Error(
      `source.schema: ${schemaFile} is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const name = source.name ?? basename(source.schema, extname(source.schema)).replace(/\.schema$/, '');
  const warnings: string[] = [];
  const examples: TaggedExample[] = [];
  if (source.examples !== undefined) {
    for (const { file, payload } of await readExamples(resolve(options.contractDir, source.examples))) {
      if (!validate(payload)) {
        const why = (validate.errors ?? [])
          .map((e: ErrorObject) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim())
          .join('; ');
        throw new Error(`source.examples: ${file} does not match the schema: ${why}`);
      }
      examples.push({ event: name, payload });
    }
  }
  if (examples.length === 0) {
    warnings.push(`${name}: no example payload given; generated cases will have to synthesise one`);
  }

  const digest = createHash('sha256').update(JSON.stringify(stable(schema))).digest('hex');
  const shape = await commitShape(`schema.${name}`, { ...schema, [EVENT_KEY]: name }, examples, options);
  return { shape, specVersion: `sha256:${digest.slice(0, 12)}`, events: [name], warnings };
}
