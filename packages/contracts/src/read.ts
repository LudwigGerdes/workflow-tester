import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LineCounter, parseDocument, type Document } from 'yaml';
import { ContractError, type Contract, type ContractIssue } from './types.js';

/**
 * A path into a payload: dotted segments, with `[]` for "every element" and
 * `[n]` for one. Deliberately not an expression language — overrides point at
 * data, and anything cleverer belongs in a hand-written test.
 */
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*(\[\d*\])*$/;

export const isPayloadPath = (value: string): boolean =>
  value.length > 0 && value.split('.').every((segment) => SEGMENT.test(segment));

type Key = string | number;

/** Where a value sits in the source, so an error can point at it. */
function locate(doc: Document, lines: LineCounter, path: Key[]): Pick<ContractIssue, 'line' | 'column'> {
  const node: unknown = doc.getIn(path, true);
  const range = (node as { range?: [number, number, number] } | undefined)?.range;
  if (range === undefined) return {};
  const { line, col } = lines.linePos(range[0]);
  return { line, column: col };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Read and validate a contract file.
 *
 * Every problem in the file is reported at once, each located in the YAML, so a
 * user fixing a contract sees the whole list rather than one error per run.
 */
export async function readContract(file: string): Promise<{ contract: Contract; dir: string }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new ContractError(file, [
      { path: '', message: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such contract file' : String(error) },
    ]);
  }

  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines });
  const issues: ContractIssue[] = [];

  for (const error of doc.errors) {
    const { line, col } = lines.linePos(error.pos[0]);
    issues.push({ path: '', message: error.message, line, column: col });
  }
  if (issues.length > 0) throw new ContractError(file, issues);

  const raw: unknown = doc.toJS();
  const add = (path: string, keys: Key[], message: string): void => {
    issues.push({ path, message, ...locate(doc, lines, keys) });
  };

  if (!isRecord(raw)) throw new ContractError(file, [{ path: '', message: 'expected a mapping' }]);

  if (raw.version !== 1) {
    add('version', ['version'], `unsupported contract version ${String(raw.version)}; expected 1`);
  }
  if (typeof raw.trigger !== 'string' || raw.trigger.length === 0) {
    add('trigger', ['trigger'], 'name the trigger node the payload arrives at');
  }

  const source = raw.source;
  if (!isRecord(source)) {
    add('source', ['source'], 'missing source block');
  } else {
    if (source.kind !== 'vendor') {
      add('source.kind', ['source', 'kind'], `unknown source kind "${String(source.kind)}"; only "vendor" is supported in v1`);
    }
    if (typeof source.vendor !== 'string' || source.vendor.length === 0) {
      add('source.vendor', ['source', 'vendor'], 'name the vendor');
    }
    if (!Array.isArray(source.events) || source.events.length === 0) {
      add('source.events', ['source', 'events'], 'list at least one event');
    } else {
      source.events.forEach((event, index) => {
        if (typeof event !== 'string' || event.length === 0) {
          add(`source.events[${index}]`, ['source', 'events', index], 'event names must be non-empty strings');
        }
      });
    }
  }

  const overrides = raw.overrides;
  if (overrides !== undefined) {
    if (!isRecord(overrides)) {
      add('overrides', ['overrides'], 'expected a mapping');
    } else {
      for (const key of ['required', 'never', 'only'] as const) {
        const list = overrides[key];
        if (list === undefined) continue;
        if (!Array.isArray(list)) {
          add(`overrides.${key}`, ['overrides', key], 'expected a list');
          continue;
        }
        // `only` names events, the other two name payload paths
        if (key === 'only') continue;
        list.forEach((entry, index) => {
          if (typeof entry !== 'string' || !isPayloadPath(entry)) {
            add(
              `overrides.${key}[${index}]`,
              ['overrides', key, index],
              `"${String(entry)}" is not a payload path (dotted names, with [] or [n] for arrays)`,
            );
          }
        });
      }
    }
  }

  if (issues.length > 0) throw new ContractError(file, issues);
  return { contract: raw as unknown as Contract, dir: dirname(file) };
}
