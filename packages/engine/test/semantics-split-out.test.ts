import { describe, expect, it } from 'vitest';
import { items, runSemantics } from './helpers.js';

const run = (params: Record<string, unknown>, input: Parameters<typeof runSemantics>[3]) =>
  runSemantics('n8n-nodes-base.splitOut', 1, params, input);

describe('Split Out semantics', () => {
  it('emits one item per element of an array of objects', () => {
    const { outputs } = run(
      { fieldToSplitOut: 'lines', include: 'noOtherFields', options: {} },
      items({ id: 1, lines: [{ sku: 'A' }, { sku: 'B' }] }),
    );
    expect(outputs[0]?.map((o) => o.json)).toEqual([{ sku: 'A' }, { sku: 'B' }]);
  });

  it('pairs every element back to the item it came from', () => {
    const { outputs } = run(
      { fieldToSplitOut: 'lines', include: 'noOtherFields', options: {} },
      items({ lines: [1, 2] }, { lines: [3] }),
    );
    expect(outputs[0]?.map((o) => o.pairedItem)).toEqual([{ item: 0 }, { item: 0 }, { item: 1 }]);
  });

  it('keeps scalars under the field name', () => {
    const { outputs } = run(
      { fieldToSplitOut: 'tags', include: 'noOtherFields', options: {} },
      items({ tags: ['x', 'y'] }),
    );
    expect(outputs[0]?.map((o) => o.json)).toEqual([{ tags: 'x' }, { tags: 'y' }]);
  });

  it('carries the other fields when asked', () => {
    const { outputs } = run(
      { fieldToSplitOut: 'lines', include: 'allOtherFields', options: {} },
      items({ id: 7, lines: [{ sku: 'A' }] }),
    );
    expect(outputs[0]?.[0]?.json).toEqual({ id: 7, sku: 'A' });
  });

  it('carries only the selected other fields', () => {
    const { outputs } = run(
      { fieldToSplitOut: 'lines', include: 'selectedOtherFields', fieldsToInclude: 'id', options: {} },
      items({ id: 7, other: 'no', lines: [{ sku: 'A' }] }),
    );
    expect(outputs[0]?.[0]?.json).toEqual({ id: 7, sku: 'A' });
  });

  it('puts elements under a destination field when named', () => {
    const { outputs } = run(
      { fieldToSplitOut: 'lines', include: 'noOtherFields', options: { destinationFieldName: 'line' } },
      items({ lines: [{ sku: 'A' }] }),
    );
    expect(outputs[0]?.[0]?.json).toEqual({ line: { sku: 'A' } });
  });

  it('splits a dotted field', () => {
    const { outputs } = run(
      { fieldToSplitOut: 'data.lines', include: 'noOtherFields', options: {} },
      items({ data: { lines: [{ sku: 'A' }] } }),
    );
    expect(outputs[0]?.map((o) => o.json)).toEqual([{ sku: 'A' }]);
  });

  it('warns instead of failing when the field is missing or not an array', () => {
    const missing = run({ fieldToSplitOut: 'lines', include: 'noOtherFields', options: {} }, items({}));
    expect(missing.outputs[0]).toEqual([]);
    expect(missing.warnings?.[0]?.message).toMatch(/missing/);

    const scalar = run({ fieldToSplitOut: 'lines', include: 'noOtherFields', options: {} }, items({ lines: 5 }));
    expect(scalar.warnings?.[0]?.message).toMatch(/not an array/);
  });

  it('emits nothing for an empty array', () => {
    const { outputs } = run({ fieldToSplitOut: 'lines', include: 'noOtherFields', options: {} }, items({ lines: [] }));
    expect(outputs[0]).toEqual([]);
  });
});
