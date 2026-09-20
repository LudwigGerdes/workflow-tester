import type { IDataObject, INodeExecutionData } from 'n8n-workflow';
import type { Semantics } from '../types.js';
import { fieldList, getField, setField } from './util.js';

interface FieldToAggregate {
  fieldToAggregate?: string;
  renameField?: boolean;
  outputFieldName?: string;
}

/** Aggregate v1 — many items in, exactly one item out. */
export const aggregateSemantics: Semantics = (ctx, input) => {
  const params = ctx.resolve(0);
  const options = (params.options ?? {}) as {
    disableDotNotation?: boolean;
    mergeLists?: boolean;
    keepMissing?: boolean;
  };
  const dotNotation = options.disableDotNotation !== true;
  const json: IDataObject = {};

  if (params.aggregate === 'aggregateAllItemData') {
    const include = (params.include as string | undefined) ?? 'allFields';
    const wanted = fieldList(params.fieldsToInclude);
    const unwanted = fieldList(params.fieldsToExclude);

    const shaped = input.map((item) => {
      if (include === 'specifiedFields') {
        const picked: IDataObject = {};
        for (const field of wanted) setField(picked, field, getField(item.json, field, dotNotation), dotNotation);
        return picked;
      }
      if (include === 'allFieldsExcept') {
        const kept: IDataObject = { ...item.json };
        for (const field of unwanted) delete kept[field];
        return kept;
      }
      return { ...item.json };
    });

    const destination = (params.destinationFieldName as string | undefined) ?? 'data';
    setField(json, destination, shaped, dotNotation);
  } else {
    const collection = (params.fieldsToAggregate ?? {}) as { fieldToAggregate?: FieldToAggregate[] };
    for (const entry of collection.fieldToAggregate ?? []) {
      const field = entry.fieldToAggregate;
      if (typeof field !== 'string' || field.length === 0) continue;
      const name =
        entry.renameField === true && typeof entry.outputFieldName === 'string' && entry.outputFieldName.length > 0
          ? entry.outputFieldName
          : field;

      const values: unknown[] = [];
      for (const item of input) {
        const value = getField(item.json, field, dotNotation);
        if (value === undefined && options.keepMissing !== true) continue;
        // `mergeLists` flattens one level: aggregating arrays yields their
        // elements rather than an array of arrays.
        if (options.mergeLists === true && Array.isArray(value)) values.push(...value);
        else values.push(value);
      }
      setField(json, name, values, dotNotation);
    }
  }

  // The single output item derives from every input item.
  const pairedItem = input.map((_item, index) => ({ item: index }));
  const output: INodeExecutionData[] = [{ json, pairedItem }];
  return { outputs: [output] };
};
