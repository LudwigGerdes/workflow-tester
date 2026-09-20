import type { IDataObject, INodeExecutionData, IPairedItemData } from 'n8n-workflow';
import { UnsupportedModeError, type Semantics } from '../types.js';

interface ClashHandling {
  values?: { resolveClash?: string; mergeMode?: string; overrideEmpty?: boolean };
}

const isObject = (v: unknown): v is IDataObject =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * n8n treats input 0 as implicit: it writes `{ item: 0 }`, never
 * `{ item: 0, input: 0 }`. Confirmed against a captured execution — the shape
 * matters because paired-item lookups compare these records.
 */
const paired = (item: number, input: number): IPairedItemData =>
  input === 0 ? { item } : { item, input };

/** Recursive merge; `later` wins on a clash. Arrays are replaced, not concatenated. */
function deepMerge(earlier: IDataObject, later: IDataObject): IDataObject {
  const out: IDataObject = { ...earlier };
  for (const [key, value] of Object.entries(later)) {
    const existing = out[key];
    out[key] = isObject(existing) && isObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

/**
 * Merge v3.
 *
 * Only the modes whose result follows from the inputs alone are interpreted:
 * `append`, `combine` by position, and `chooseBranch`. Combining by matching
 * fields or by SQL is a boundary — the outcome depends on data relationships
 * the engine would have to guess at, and a plausible-looking wrong answer is
 * worse than an honest "tier 2 runs this".
 */
export const mergeSemantics: Semantics = (ctx, _input) => {
  const params = ctx.resolve(0);
  const mode = (params.mode as string | undefined) ?? 'append';
  const inputs = ctx.inputs;

  if (mode === 'append') {
    const merged: INodeExecutionData[] = [];
    inputs.forEach((items, input) => {
      items.forEach((item, index) => {
        merged.push({ ...item, pairedItem: paired(index, input) });
      });
    });
    return { outputs: [merged] };
  }

  if (mode === 'chooseBranch') {
    const output = (params.output as string | undefined) ?? 'specifiedInput';
    if (output === 'empty') return { outputs: [[]] };
    // `useDataOfInput` is 1-based, as the editor shows it.
    const which = Number(params.useDataOfInput ?? 1) - 1;
    const chosen = inputs[which] ?? [];
    return {
      outputs: [chosen.map((item, index) => ({ ...item, pairedItem: paired(index, which) }))],
    };
  }

  if (mode === 'combine') {
    const combineBy = (params.combineBy as string | undefined) ?? 'combineByFields';
    if (combineBy !== 'combineByPosition') {
      throw new UnsupportedModeError(
        ctx.node.name,
        `Merge combining by ${combineBy === 'combineAll' ? 'all combinations' : 'matching fields'} depends on data relationships; tier 2 runs it`,
      );
    }

    const clash = ((params.options as { clashHandling?: ClashHandling } | undefined)?.clashHandling ?? {})
      .values;
    const resolveClash = clash?.resolveClash ?? 'preferLast';
    const mergeMode = clash?.mergeMode ?? 'deepMerge';
    if (resolveClash === 'addSuffix') {
      throw new UnsupportedModeError(
        ctx.node.name,
        'Merge with addSuffix clash handling renames clashing keys; tier 2 runs it',
      );
    }

    const includeUnpaired =
      (params.options as { includeUnpaired?: boolean } | undefined)?.includeUnpaired === true;
    const lengths = inputs.map((items) => items.length);
    const limit = includeUnpaired ? Math.max(0, ...lengths) : Math.min(...(lengths.length > 0 ? lengths : [0]));

    const merged: INodeExecutionData[] = [];
    for (let position = 0; position < limit; position += 1) {
      const contributing = inputs
        .map((items, input) => ({ item: items[position], input }))
        .filter((entry): entry is { item: INodeExecutionData; input: number } => entry.item !== undefined);
      if (contributing.length === 0) continue;

      // `preferLast` is n8n's default: a later input's keys win.
      const ordered = resolveClash === 'preferLast' ? contributing : [...contributing].reverse();
      let json: IDataObject = {};
      for (const entry of ordered) {
        json = mergeMode === 'deepMerge' ? deepMerge(json, entry.item.json) : { ...json, ...entry.item.json };
      }

      const pairedItem: IPairedItemData[] = contributing.map((entry) =>
        paired(position, entry.input),
      );
      merged.push({ json, pairedItem });
    }
    return { outputs: [merged] };
  }

  throw new UnsupportedModeError(ctx.node.name, `Merge in ${mode} mode; tier 2 runs it`);
};
