import type { INodeExecutionData } from 'n8n-workflow';
import { UnsupportedModeError, type Semantics } from '../types.js';
import { getField } from './util.js';

interface SortField {
  fieldName?: string;
  order?: string;
}

/** Compare two values the way a field sort should: numbers as numbers. */
function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

/**
 * Sort v1 in `simple` mode.
 *
 * `random` is a boundary because it is not a function of its input — an offline
 * result would differ from the run it claims to predict. `code` runs arbitrary
 * JavaScript, which is a live run's business.
 */
export const sortSemantics: Semantics = (ctx, input) => {
  const params = ctx.resolve(0);
  const type = (params.type as string | undefined) ?? 'simple';
  if (type !== 'simple') {
    throw new UnsupportedModeError(
      ctx.node.name,
      type === 'random'
        ? 'Sort in random order is not a function of its input; a live run does it'
        : 'Sort by code runs JavaScript; a live run does it',
    );
  }

  const options = (params.options ?? {}) as { disableDotNotation?: boolean };
  const dotNotation = options.disableDotNotation !== true;
  const fields = ((params.sortFieldsUi ?? {}) as { sortField?: SortField[] }).sortField ?? [];

  // Sort the input positions, so each output item can be paired to where it came from.
  const positions = input.map((_item, index) => index);
  positions.sort((left, right) => {
    for (const field of fields) {
      const name = field.fieldName;
      if (typeof name !== 'string' || name.length === 0) continue;
      const a = getField((input[left] as INodeExecutionData).json, name, dotNotation);
      const b = getField((input[right] as INodeExecutionData).json, name, dotNotation);
      const result = compare(a, b);
      if (result !== 0) return field.order === 'descending' ? -result : result;
    }
    return left - right; // stable
  });

  const sorted = positions.map((index) => ({
    ...(input[index] as INodeExecutionData),
    pairedItem: { item: index },
  }));
  return { outputs: [sorted] };
};
