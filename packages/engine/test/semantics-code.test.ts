import { describe, expect, it } from 'vitest';
import { items, runSemantics } from './helpers.js';
import { ImpureCallError } from '../src/types.js';

const run = (params: Record<string, unknown>, input = items({ n: 1 }, { n: 2 })) =>
  runSemantics('n8n-nodes-base.code', 2, params, input);

describe('Code semantics', () => {
  it('runs once for all items and returns what the code returns', () => {
    const out = run({
      mode: 'runOnceForAllItems',
      jsCode: 'return $input.all().map(i => ({ doubled: i.json.n * 2 }));',
    });
    expect(out.outputs[0]?.map((o) => o.json)).toEqual([{ doubled: 2 }, { doubled: 4 }]);
  });

  it('runs once for each item', () => {
    const out = run({ mode: 'runOnceForEachItem', jsCode: 'return { doubled: $json.n * 2 };' });
    expect(out.outputs[0]?.map((o) => o.json)).toEqual([{ doubled: 2 }, { doubled: 4 }]);
  });

  it('pairs each item to its input in each-item mode', () => {
    const out = run({ mode: 'runOnceForEachItem', jsCode: 'return { n: $json.n };' });
    expect(out.outputs[0]?.map((o) => o.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
  });

  it('defaults to all-items mode when none is set', () => {
    const out = run({ jsCode: 'return [{ ok: true }];' });
    expect(out.outputs[0]?.map((o) => o.json)).toEqual([{ ok: true }]);
  });

  it('throws an impure call outward unwrapped, for the walker to record', () => {
    // Asserting the type, not the message: a wrapped error keeps the message
    // and still reaches the walker as a failure rather than a boundary.
    expect(() =>
      run({ mode: 'runOnceForAllItems', jsCode: 'return $helpers.httpRequest({});' }),
    ).toThrow(ImpureCallError);
  });

  it('refuses Python rather than attempting it', () => {
    expect(() =>
      run({ mode: 'runOnceForAllItems', language: 'python', pythonCode: 'return []' }),
    ).toThrow(/python/i);
  });

  it('rejects a return shape n8n would reject', () => {
    expect(() => run({ mode: 'runOnceForAllItems', jsCode: 'return 42;' })).toThrow();
  });

  it('surfaces console output as warnings', () => {
    const out = run({ mode: 'runOnceForAllItems', jsCode: 'console.log("seen"); return [];' });
    expect(out.warnings).toEqual([{ kind: 'code-log', node: 'N', message: 'seen' }]);
  });
});
