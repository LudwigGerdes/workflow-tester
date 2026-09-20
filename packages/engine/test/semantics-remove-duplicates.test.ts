import { describe, expect, it } from 'vitest';
import { items, runSemantics } from './helpers.js';
import { UnsupportedModeError } from '../src/types.js';

const run = (params: Record<string, unknown>, input: Parameters<typeof runSemantics>[3]) =>
  runSemantics('n8n-nodes-base.removeDuplicates', 2, params, input);

const base = { operation: 'removeDuplicateInputItems', options: {} };

describe('Remove Duplicates semantics', () => {
  it('drops later items identical across all fields', () => {
    const { outputs } = run({ ...base, compare: 'allFields' }, items({ a: 1 }, { a: 1 }, { a: 2 }));
    expect(outputs[0]?.map((o) => o.json)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('ignores key order when comparing', () => {
    const { outputs } = run({ ...base, compare: 'allFields' }, items({ a: 1, b: 2 }, { b: 2, a: 1 }));
    expect(outputs[0]).toHaveLength(1);
  });

  it('compares only the selected fields', () => {
    const { outputs } = run(
      { ...base, compare: 'selectedFields', fieldsToCompare: 'id' },
      items({ id: 1, noise: 'x' }, { id: 1, noise: 'y' }, { id: 2, noise: 'z' }),
    );
    expect(outputs[0]?.map((o) => (o.json as { id: number }).id)).toEqual([1, 2]);
  });

  it('compares every field except the excluded ones', () => {
    const { outputs } = run(
      { ...base, compare: 'allFieldsExcept', fieldsToExclude: 'seen' },
      items({ id: 1, seen: 'a' }, { id: 1, seen: 'b' }),
    );
    expect(outputs[0]).toHaveLength(1);
  });

  it('keeps the first occurrence and pairs it to its position', () => {
    const { outputs } = run({ ...base, compare: 'allFields' }, items({ a: 1 }, { a: 2 }, { a: 2 }));
    expect(outputs[0]?.map((o) => o.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
  });

  it.each(['removeItemsSeenInPreviousExecutions', 'clearDeduplicationHistory'])(
    'treats %s as a boundary',
    (operation) => {
      expect(() => run({ operation, options: {} }, items({ a: 1 }))).toThrow(UnsupportedModeError);
    },
  );
});
