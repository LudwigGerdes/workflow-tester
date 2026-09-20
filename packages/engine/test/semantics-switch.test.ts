import { describe, expect, it } from 'vitest';
import type { INode, INodeExecutionData } from 'n8n-workflow';
import { semanticsFor } from '../src/semantics/index.js';
import { UnsupportedModeError, type SemanticsContext } from '../src/types.js';

const SWITCH = 'n8n-nodes-base.switch';

const items = (...jsons: Array<Record<string, unknown>>): INodeExecutionData[] =>
  jsons.map((json, item) => ({ json, pairedItem: { item } }));

const run = (params: Record<string, unknown> | ((i: number) => Record<string, unknown>), input: INodeExecutionData[]) => {
  const semantics = semanticsFor(SWITCH, 3.3);
  if (semantics === undefined) throw new Error('no switch semantics');
  const node: INode = { parameters: {}, id: 'S', name: 'S', type: SWITCH, typeVersion: 3.3, position: [0, 0] };
  const ctx: SemanticsContext = {
    node,
    inputs: [input],
    resolve: (i) => (typeof params === 'function' ? params(i) : params),
  };
  return semantics(ctx, input);
};

/** A rule matching when `json.kind` equals `value`. */
const rule = (value: string, outputKey = value) => ({
  outputKey,
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [
      { id: `c-${value}`, leftValue: '={{ $json.kind }}', rightValue: value, operator: { type: 'string', operation: 'equals' } },
    ],
    combinator: 'and',
  },
});

/** Conditions are pre-resolved by the walker, so the fixture resolves them too. */
const resolved = (kind: string, values: Array<ReturnType<typeof rule>>, options: Record<string, unknown> = {}) => ({
  mode: 'rules',
  rules: {
    values: values.map((v) => ({
      ...v,
      conditions: {
        ...v.conditions,
        conditions: v.conditions.conditions.map((c) => ({ ...c, leftValue: kind })),
      },
    })),
  },
  options,
});

describe('Switch semantics', () => {
  it('routes each item to the output its rule owns', () => {
    const rules = [rule('a'), rule('b'), rule('c')];
    const { outputs } = run((i) => resolved(i === 0 ? 'a' : 'c', rules), items({ n: 0 }, { n: 1 }));
    expect(outputs[0]?.map((o) => o.json)).toEqual([{ n: 0 }]);
    expect(outputs[1]).toEqual([]);
    expect(outputs[2]?.map((o) => o.json)).toEqual([{ n: 1 }]);
  });

  it('gives every rule an output even when nothing matched', () => {
    const { outputs } = run(resolved('zzz', [rule('a'), rule('b')]), items({}));
    expect(outputs).toHaveLength(2);
    expect(outputs.flat()).toEqual([]);
  });

  it('stops at the first matching rule by default', () => {
    const both = [rule('a', 'first'), rule('a', 'second')];
    const { outputs } = run(resolved('a', both), items({}));
    expect(outputs[0]).toHaveLength(1);
    expect(outputs[1]).toHaveLength(0);
  });

  it('routes to every matching rule when asked to', () => {
    const both = [rule('a', 'first'), rule('a', 'second')];
    const { outputs } = run(resolved('a', both, { allMatchingOutputs: true }), items({}));
    expect(outputs[0]).toHaveLength(1);
    expect(outputs[1]).toHaveLength(1);
  });

  it('drops an unmatched item when there is no fallback', () => {
    const { outputs } = run(resolved('zzz', [rule('a')]), items({}));
    expect(outputs.flat()).toEqual([]);
  });

  it('sends unmatched items to an extra output', () => {
    const { outputs } = run(resolved('zzz', [rule('a')], { fallbackOutput: 'extra' }), items({ n: 1 }));
    expect(outputs[1]?.map((o) => o.json)).toEqual([{ n: 1 }]);
  });

  it('sends unmatched items to a named output index', () => {
    const { outputs } = run(resolved('zzz', [rule('a'), rule('b')], { fallbackOutput: 1 }), items({ n: 1 }));
    expect(outputs[1]?.map((o) => o.json)).toEqual([{ n: 1 }]);
  });

  it('keeps paired items pointing at the input index', () => {
    const { outputs } = run((i) => resolved(i === 1 ? 'a' : 'zz', [rule('a')]), items({ n: 0 }, { n: 1 }));
    expect(outputs[0]?.[0]?.pairedItem).toEqual({ item: 1 });
  });

  it('treats expression mode as a boundary rather than guessing', () => {
    expect(() => run({ mode: 'expression', output: 1, options: {} }, items({}))).toThrow(UnsupportedModeError);
  });
});
