import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Catalog } from 'workflow-tester-vendors';
import { parseDocument } from 'yaml';
import type { Contract } from './types.js';

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
  const only = contract.overrides?.only;
  const requested =
    only === undefined || only.length === 0
      ? contract.source.events
      : contract.source.events.filter((event) => only.includes(event));

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

  const slug = slugFor(requested);
  const base = `${catalog.vendor}.${slug}`;
  await mkdir(options.outDir, { recursive: true });

  const schemaFile = join(options.outDir, `${base}.schema.json`);
  const examplesFile = join(options.outDir, `${base}.examples.json`);

  // A single event needs no oneOf: the branch is the shape.
  const schema = branches.length === 1 ? (branches[0] as Record<string, unknown>) : { oneOf: branches };
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

  return { shape, specVersion: catalog.specVersion, events: requested, warnings };
}
