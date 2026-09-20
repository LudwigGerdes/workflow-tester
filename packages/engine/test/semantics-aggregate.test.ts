import { describe, expect, it } from 'vitest';
import { items, runSemantics } from './helpers.js';

const run = (params: Record<string, unknown>, input: Parameters<typeof runSemantics>[3]) =>
  runSemantics('n8n-nodes-base.aggregate', 1, params, input);

const fields = (...names: Array<{ field: string; as?: string }>) => ({
  aggregate: 'aggregateIndividualFields',
  fieldsToAggregate: {
    fieldToAggregate: names.map((n) => ({
      fieldToAggregate: n.field,
      renameField: n.as !== undefined,
      outputFieldName: n.as,
    })),
  },
  options: {},
});

describe('Aggregate semantics', () => {
  it('collects one field across every item into a single item', () => {
    const { outputs } = run(fields({ field: 'sku' }), items({ sku: 'A' }, { sku: 'B' }));
    expect(outputs[0]).toHaveLength(1);
    expect(outputs[0]?.[0]?.json).toEqual({ sku: ['A', 'B'] });
  });

  it('renames the aggregated field when asked', () => {
    const { outputs } = run(fields({ field: 'sku', as: 'skus' }), items({ sku: 'A' }));
    expect(outputs[0]?.[0]?.json).toEqual({ skus: ['A'] });
  });

  it('aggregates several fields at once', () => {
    const { outputs } = run(fields({ field: 'a' }, { field: 'b' }), items({ a: 1, b: 2 }, { a: 3, b: 4 }));
    expect(outputs[0]?.[0]?.json).toEqual({ a: [1, 3], b: [2, 4] });
  });

  it('skips missing values unless told to keep them', () => {
    expect((run(fields({ field: 'a' }), items({ a: 1 }, {})).outputs[0]?.[0]?.json as { a: unknown[] }).a).toEqual([1]);
    const kept = run({ ...fields({ field: 'a' }), options: { keepMissing: true } }, items({ a: 1 }, {}));
    expect((kept.outputs[0]?.[0]?.json as { a: unknown[] }).a).toEqual([1, undefined]);
  });

  it('flattens one level when merging lists', () => {
    const { outputs } = run(
      { ...fields({ field: 'tags' }), options: { mergeLists: true } },
      items({ tags: ['a', 'b'] }, { tags: ['c'] }),
    );
    expect(outputs[0]?.[0]?.json).toEqual({ tags: ['a', 'b', 'c'] });
  });

  it('puts all item data under one field', () => {
    const { outputs } = run(
      { aggregate: 'aggregateAllItemData', destinationFieldName: 'data', include: 'allFields', options: {} },
      items({ a: 1 }, { a: 2 }),
    );
    expect(outputs[0]?.[0]?.json).toEqual({ data: [{ a: 1 }, { a: 2 }] });
  });

  it('narrows all item data to specified fields', () => {
    const { outputs } = run(
      {
        aggregate: 'aggregateAllItemData', destinationFieldName: 'data',
        include: 'specifiedFields', fieldsToInclude: 'a', options: {},
      },
      items({ a: 1, b: 9 }),
    );
    expect(outputs[0]?.[0]?.json).toEqual({ data: [{ a: 1 }] });
  });

  it('excludes fields from all item data', () => {
    const { outputs } = run(
      {
        aggregate: 'aggregateAllItemData', destinationFieldName: 'data',
        include: 'allFieldsExcept', fieldsToExclude: 'b', options: {},
      },
      items({ a: 1, b: 9 }),
    );
    expect(outputs[0]?.[0]?.json).toEqual({ data: [{ a: 1 }] });
  });

  it('pairs its one output item to every input item', () => {
    const { outputs } = run(fields({ field: 'a' }), items({ a: 1 }, { a: 2 }, { a: 3 }));
    expect(outputs[0]?.[0]?.pairedItem).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
  });
});
