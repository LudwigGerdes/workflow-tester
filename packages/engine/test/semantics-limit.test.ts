import { describe, expect, it } from 'vitest';
import { items, runSemantics } from './helpers.js';

const run = (params: Record<string, unknown>, input = items({ n: 1 }, { n: 2 }, { n: 3 })) =>
  runSemantics('n8n-nodes-base.limit', 1, params, input);

describe('Limit semantics', () => {
  it('keeps the first N by default', () => {
    expect(run({ maxItems: 2, keep: 'firstItems' }).outputs[0]?.map((o) => o.json)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('keeps the last N when asked', () => {
    expect(run({ maxItems: 2, keep: 'lastItems' }).outputs[0]?.map((o) => o.json)).toEqual([{ n: 2 }, { n: 3 }]);
  });

  it('keeps everything when the limit exceeds the input', () => {
    expect(run({ maxItems: 99, keep: 'firstItems' }).outputs[0]).toHaveLength(3);
  });

  it('keeps nothing at a limit of zero', () => {
    expect(run({ maxItems: 0, keep: 'firstItems' }).outputs[0]).toEqual([]);
  });

  it('pairs each kept item to where it came from', () => {
    expect(run({ maxItems: 2, keep: 'lastItems' }).outputs[0]?.map((o) => o.pairedItem)).toEqual([
      { item: 1 },
      { item: 2 },
    ]);
  });
});
