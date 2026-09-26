import type { IDataObject, INodeExecutionData } from 'n8n-workflow';
import { UnsupportedModeError, type Semantics } from '../types.js';
import { getField, setField } from './util.js';

interface KeyRename {
  currentKey?: string;
  newKey?: string;
}

/**
 * Rename Keys v1. Regex replacement is a boundary: it rewrites key names by
 * pattern across the whole item, and getting that subtly wrong is worse than
 * declining it.
 */
export const renameKeysSemantics: Semantics = (ctx, input) => {
  const output: INodeExecutionData[] = input.map((item, index) => {
    const params = ctx.resolve(index);
    const additional = (params.additionalOptions ?? {}) as { regexReplacement?: unknown };
    if (additional.regexReplacement !== undefined) {
      throw new UnsupportedModeError(ctx.node.name, 'Rename Keys by regex; a live run does it');
    }

    const renames = ((params.keys ?? {}) as { key?: KeyRename[] }).key ?? [];
    const json: IDataObject = { ...item.json };

    for (const rename of renames) {
      const { currentKey, newKey } = rename;
      if (typeof currentKey !== 'string' || typeof newKey !== 'string') continue;
      if (currentKey.length === 0 || newKey.length === 0) continue;
      const value = getField(json, currentKey);
      if (value === undefined) continue;
      setField(json, newKey, value);
      // Only a top-level rename removes its source; a dotted rename copies out.
      if (!currentKey.includes('.')) delete json[currentKey];
    }

    return { json, pairedItem: { item: index } };
  });

  return { outputs: [output] };
};
