import type { IDataObject, INodeExecutionData } from 'n8n-workflow';

/**
 * A Code node return value that cannot be turned into items.
 *
 * Being strict here is the point. n8n rejects these shapes at run time, so
 * accepting one would mean this engine reports a pass for a workflow that
 * fails in production — the confidently-wrong result the offline walk exists to
 * avoid.
 */
export class CodeResultError extends Error {
  constructor(
    readonly node: string,
    message: string,
  ) {
    super(`${node} ${message}`);
    this.name = 'CodeResultError';
  }
}

/** The top-level keys an n8n item may carry. Anything else is a mistake. */
const ITEM_KEYS = new Set(['json', 'binary', 'pairedItem', 'error']);

// Typed as IDataObject to match the guard merge.ts already uses; n8n's item
// json is IDataObject, not Record<string, unknown>.
const isPlainObject = (v: unknown): v is IDataObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Bring a Code node's return value out of the vm's realm and into this one.
 *
 * Objects made inside `node:vm` belong to another realm, and the structured
 * clone that carries a result out of the sandbox worker refuses them —
 * `#<Object> could not be cloned`. The walk itself is unaffected, so this only
 * ever surfaced on a run that crossed the worker boundary: every run the CLI
 * makes, and no test that called `walk` directly.
 *
 * Rebuilt rather than JSON round-tripped, so a Date stays a Date. Typed arrays
 * pass through untouched — structured clone handles those, and rebuilding one
 * as a plain object would corrupt binary data. `seen` tracks the current path
 * only, so an object referenced twice is fine and a genuine cycle is an error.
 */
function intoThisRealm(value: unknown, node: string, seen: Set<object> = new Set()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return new Date((value as Date).getTime());
  }
  if (seen.has(value)) {
    throw new CodeResultError(node, 'returned data that refers to itself');
  }

  seen.add(value);
  const rebuilt = Array.isArray(value)
    ? value.map((entry) => intoThisRealm(entry, node, seen))
    : Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
          key,
          intoThisRealm(entry, node, seen),
        ]),
      );
  seen.delete(value);
  return rebuilt;
}

/**
 * `{ json: ... }` is n8n's item envelope; an object without `json` is the
 * payload itself and gets wrapped.
 */
function toItem(raw: unknown, node: string): INodeExecutionData {
  // Done once, here, because every path into an item comes through this
  // function and everything downstream should be ours rather than the vm's.
  const value = intoThisRealm(raw, node);
  if (!isPlainObject(value)) {
    throw new CodeResultError(
      node,
      `returned ${value === null ? 'null' : typeof value}, which cannot be an item`,
    );
  }

  if (!('json' in value)) return { json: value };

  if (!isPlainObject(value.json)) {
    throw new CodeResultError(node, 'returned an item whose `json` is not an object');
  }

  const unknown = Object.keys(value).filter((key) => !ITEM_KEYS.has(key));
  if (unknown.length > 0) {
    throw new CodeResultError(
      node,
      `returned an item with unrecognised key${unknown.length === 1 ? '' : 's'} ${unknown
        .map((k) => `\`${k}\``)
        .join(', ')}; move them inside \`json\``,
    );
  }

  // Built key by key rather than cast: the validation above guarantees only
  // these keys are present, and each is narrowed on its way in.
  const item: INodeExecutionData = { json: value.json };
  if (value.pairedItem !== undefined) {
    item.pairedItem = value.pairedItem as INodeExecutionData['pairedItem'];
  }
  if (value.binary !== undefined) {
    item.binary = value.binary as INodeExecutionData['binary'];
  }
  return item;
}

/** Normalize the return of a `runOnceForAllItems` Code node. */
export function normalizeAllItems(raw: unknown, node: string): INodeExecutionData[] {
  if (!isPlainObject(raw) && !Array.isArray(raw)) {
    throw new CodeResultError(
      node,
      raw === undefined
        ? 'returned nothing; a Code node must return items'
        : `returned ${raw === null ? 'null' : typeof raw}, which cannot be items`,
    );
  }
  // n8n pairs every item from an all-items run to input item 0: with the whole
  // input in scope it cannot know which item produced which output. Verified
  // against a captured execution in the execution-fixture suite.
  const paired = (item: INodeExecutionData): INodeExecutionData =>
    item.pairedItem === undefined ? { ...item, pairedItem: { item: 0 } } : item;

  if (Array.isArray(raw)) return raw.map((entry) => paired(toItem(entry, node)));
  return [paired(toItem(raw, node))];
}

/** Normalize the return of one iteration of a `runOnceForEachItem` Code node. */
export function normalizeEachItem(
  raw: unknown,
  node: string,
  itemIndex: number,
): INodeExecutionData {
  if (Array.isArray(raw)) {
    throw new CodeResultError(node, 'returned an array in run-once-for-each-item mode');
  }
  return { ...toItem(raw, node), pairedItem: { item: itemIndex } };
}
