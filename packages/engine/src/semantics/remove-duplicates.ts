import type { IDataObject, INodeExecutionData } from 'n8n-workflow';
import { UnsupportedModeError, type Semantics } from '../types.js';
import { fieldList, getField, keyOf, setField } from './util.js';

/**
 * Remove Duplicates v2, comparing items within one run.
 *
 * The operations that compare against previous executions read and write
 * persisted state, so they are boundaries: their result depends on history the
 * engine does not have.
 */
export const removeDuplicatesSemantics: Semantics = (ctx, input) => {
  const params = ctx.resolve(0);
  const operation = (params.operation as string | undefined) ?? 'removeDuplicateInputItems';
  if (operation !== 'removeDuplicateInputItems') {
    throw new UnsupportedModeError(
      ctx.node.name,
      `Remove Duplicates "${operation}" depends on stored history from previous executions; a live run does it`,
    );
  }

  const options = (params.options ?? {}) as { disableDotNotation?: boolean };
  const dotNotation = options.disableDotNotation !== true;
  const compare = (params.compare as string | undefined) ?? 'allFields';

  const subject = (json: IDataObject): unknown => {
    if (compare === 'selectedFields') {
      const picked: IDataObject = {};
      for (const field of fieldList(params.fieldsToCompare)) {
        setField(picked, field, getField(json, field, dotNotation), dotNotation);
      }
      return picked;
    }
    if (compare === 'allFieldsExcept') {
      const kept: IDataObject = { ...json };
      for (const field of fieldList(params.fieldsToExclude)) delete kept[field];
      return kept;
    }
    return json;
  };

  const seen = new Set<string>();
  const kept: INodeExecutionData[] = [];
  input.forEach((item, index) => {
    const key = keyOf(subject(item.json));
    if (seen.has(key)) return;
    seen.add(key);
    kept.push({ ...item, pairedItem: { item: index } });
  });

  return { outputs: [kept] };
};
