import { describe, expect, it } from 'vitest';
import { items, runSemantics } from './helpers.js';
import { UnsupportedModeError } from '../src/types.js';

const run = (params: Record<string, unknown>, input: Parameters<typeof runSemantics>[3]) =>
  runSemantics('n8n-nodes-base.sort', 1, params, input);

const by = (...fields: Array<[string, string]>) => ({
  type: 'simple',
  sortFieldsUi: { sortField: fields.map(([fieldName, order]) => ({ fieldName, order })) },
  options: {},
});

describe('Sort semantics', () => {
  it('sorts ascending by a field', () => {
    const { outputs } = run(by(['n', 'ascending']), items({ n: 3 }, { n: 1 }, { n: 2 }));
    expect(outputs[0]?.map((o) => (o.json as { n: number }).n)).toEqual([1, 2, 3]);
  });

  it('sorts descending', () => {
    const { outputs } = run(by(['n', 'descending']), items({ n: 1 }, { n: 3 }, { n: 2 }));
    expect(outputs[0]?.map((o) => (o.json as { n: number }).n)).toEqual([3, 2, 1]);
  });

  it('compares numbers as numbers, not as text', () => {
    const { outputs } = run(by(['n', 'ascending']), items({ n: 10 }, { n: 9 }));
    expect(outputs[0]?.map((o) => (o.json as { n: number }).n)).toEqual([9, 10]);
  });

  it('falls through to the next field on a tie', () => {
    const { outputs } = run(
      by(['group', 'ascending'], ['n', 'ascending']),
      items({ group: 'a', n: 2 }, { group: 'a', n: 1 }, { group: 'b', n: 0 }),
    );
    expect(outputs[0]?.map((o) => o.json)).toEqual([
      { group: 'a', n: 1 },
      { group: 'a', n: 2 },
      { group: 'b', n: 0 },
    ]);
  });

  it('is stable when everything ties', () => {
    const { outputs } = run(by(['same', 'ascending']), items({ same: 1, id: 'first' }, { same: 1, id: 'second' }));
    expect(outputs[0]?.map((o) => (o.json as { id: string }).id)).toEqual(['first', 'second']);
  });

  it('sorts on a dotted field', () => {
    const { outputs } = run(by(['user.age', 'ascending']), items({ user: { age: 40 } }, { user: { age: 20 } }));
    expect(outputs[0]?.map((o) => (o.json as { user: { age: number } }).user.age)).toEqual([20, 40]);
  });

  it('pairs each sorted item back to its original position', () => {
    const { outputs } = run(by(['n', 'ascending']), items({ n: 3 }, { n: 1 }));
    expect(outputs[0]?.map((o) => o.pairedItem)).toEqual([{ item: 1 }, { item: 0 }]);
  });

  it.each(['random', 'code'])('treats %s ordering as a boundary', (type) => {
    expect(() => run({ type, options: {} }, items({ n: 1 }))).toThrow(UnsupportedModeError);
  });
});
