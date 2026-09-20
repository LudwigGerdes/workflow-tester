import type { IDataObject, INodeExecutionData } from 'n8n-workflow';
import type { Semantics, Warning } from '../types.js';
import { fieldList, getField, setField } from './util.js';

/**
 * Split Out v1 — one output item per element of the field being split.
 *
 * Paired items point back at the item the elements came from, which is what
 * makes `$('Trigger').item` still resolve downstream of a fan-out.
 */
export const splitOutSemantics: Semantics = (ctx, input) => {
  const output: INodeExecutionData[] = [];
  const warnings: Warning[] = [];

  input.forEach((item, index) => {
    const params = ctx.resolve(index);
    const options = (params.options ?? {}) as {
      disableDotNotation?: boolean;
      destinationFieldName?: string;
    };
    const dotNotation = options.disableDotNotation !== true;
    const fields = fieldList(params.fieldToSplitOut);
    const include = (params.include as string | undefined) ?? 'noOtherFields';

    /** What travels alongside each split element. */
    const carried = (): IDataObject => {
      if (include === 'allOtherFields') {
        const rest: IDataObject = { ...item.json };
        for (const field of fields) delete rest[field];
        return rest;
      }
      if (include === 'selectedOtherFields') {
        const rest: IDataObject = {};
        for (const field of fieldList(params.fieldsToInclude)) {
          setField(rest, field, getField(item.json, field, dotNotation), dotNotation);
        }
        return rest;
      }
      return {};
    };

    const [primary] = fields;
    if (primary === undefined) return;
    const value = getField(item.json, primary, dotNotation);

    if (!Array.isArray(value)) {
      warnings.push({
        kind: 'optional-undefined',
        node: ctx.node.name,
        parameter: 'fieldToSplitOut',
        message: `"${primary}" is ${value === undefined ? 'missing' : 'not an array'}, so nothing was split out`,
        itemIndex: index,
      });
      return;
    }

    const destination = options.destinationFieldName;
    for (const element of value) {
      const json: IDataObject = carried();
      if (typeof destination === 'string' && destination.length > 0) {
        setField(json, destination, element, dotNotation);
      } else if (element !== null && typeof element === 'object' && !Array.isArray(element)) {
        Object.assign(json, element as IDataObject);
      } else {
        setField(json, primary, element, dotNotation);
      }
      output.push({ json, pairedItem: { item: index } });
    }
  });

  return { outputs: [output], warnings };
};
