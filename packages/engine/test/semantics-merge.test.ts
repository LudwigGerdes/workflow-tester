import { describe, expect, it } from 'vitest';
import type { INode, INodeExecutionData } from 'n8n-workflow';
import { semanticsFor } from '../src/semantics/index.js';
import { UnsupportedModeError, type SemanticsContext } from '../src/types.js';

const MERGE = 'n8n-nodes-base.merge';

const items = (...jsons: Array<Record<string, unknown>>): INodeExecutionData[] =>
  jsons.map((json, item) => ({ json, pairedItem: { item } }));

const run = (params: Record<string, unknown>, inputs: INodeExecutionData[][]) => {
  const semantics = semanticsFor(MERGE, 3.2);
  if (semantics === undefined) throw new Error('no merge semantics');
  const node: INode = { parameters: {}, id: 'M', name: 'M', type: MERGE, typeVersion: 3.2, position: [0, 0] };
  const ctx: SemanticsContext = { node, inputs, resolve: () => params };
  return semantics(ctx, inputs[0] ?? []);
};

describe('Merge semantics', () => {
  it('appends inputs in order, recording which input each item came from', () => {
    const { outputs } = run({ mode: 'append', numberInputs: 2 }, [items({ a: 1 }), items({ b: 2 }, { b: 3 })]);
    expect(outputs[0]?.map((o) => o.json)).toEqual([{ a: 1 }, { b: 2 }, { b: 3 }]);
    // input 0 is implicit in n8n's paired-item records — confirmed by a
    // captured execution, which writes `{ item: 0 }` and never `{ input: 0 }`
    expect(outputs[0]?.map((o) => o.pairedItem)).toEqual([
      { item: 0 },
      { item: 0, input: 1 },
      { item: 1, input: 1 },
    ]);
  });

  it('combines by position, letting the later input win a clash', () => {
    const { outputs } = run({ mode: 'combine', combineBy: 'combineByPosition', options: {} }, [
      items({ id: 1, who: 'first' }),
      items({ who: 'second', extra: true }),
    ]);
    expect(outputs[0]?.[0]?.json).toEqual({ id: 1, who: 'second', extra: true });
  });

  it('deep-merges nested objects by default', () => {
    const { outputs } = run({ mode: 'combine', combineBy: 'combineByPosition', options: {} }, [
      items({ user: { name: 'Ada', city: 'London' } }),
      items({ user: { city: 'Paris' } }),
    ]);
    expect(outputs[0]?.[0]?.json).toEqual({ user: { name: 'Ada', city: 'Paris' } });
  });

  it('replaces wholesale when asked to merge shallowly', () => {
    const { outputs } = run(
      {
        mode: 'combine',
        combineBy: 'combineByPosition',
        options: { clashHandling: { values: { resolveClash: 'preferLast', mergeMode: 'shallowMerge' } } },
      },
      [items({ user: { name: 'Ada', city: 'London' } }), items({ user: { city: 'Paris' } })],
    );
    expect(outputs[0]?.[0]?.json).toEqual({ user: { city: 'Paris' } });
  });

  it('stops at the shorter input unless unpaired items are wanted', () => {
    const inputs = [items({ a: 1 }, { a: 2 }), items({ b: 1 })];
    expect(run({ mode: 'combine', combineBy: 'combineByPosition', options: {} }, inputs).outputs[0]).toHaveLength(1);
    expect(
      run({ mode: 'combine', combineBy: 'combineByPosition', options: { includeUnpaired: true } }, inputs)
        .outputs[0],
    ).toHaveLength(2);
  });

  it('pairs a combined item back to every input that contributed', () => {
    const { outputs } = run({ mode: 'combine', combineBy: 'combineByPosition', options: {} }, [
      items({ a: 1 }),
      items({ b: 2 }),
    ]);
    expect(outputs[0]?.[0]?.pairedItem).toEqual([{ item: 0 }, { item: 0, input: 1 }]);
  });

  it('chooses a branch by its 1-based input number', () => {
    const inputs = [items({ a: 1 }), items({ b: 2 })];
    expect(run({ mode: 'chooseBranch', output: 'specifiedInput', useDataOfInput: 2 }, inputs).outputs[0]?.map((o) => o.json)).toEqual([{ b: 2 }]);
    expect(run({ mode: 'chooseBranch', output: 'specifiedInput', useDataOfInput: 1 }, inputs).outputs[0]?.map((o) => o.json)).toEqual([{ a: 1 }]);
  });

  it('emits nothing when the chosen branch is empty', () => {
    const { outputs } = run({ mode: 'chooseBranch', output: 'empty' }, [items({ a: 1 }), items({ b: 2 })]);
    expect(outputs[0]).toEqual([]);
  });

  it.each([
    [{ mode: 'combine', combineBy: 'combineByFields', options: {} }, 'matching fields'],
    [{ mode: 'combine', combineBy: 'combineAll', options: {} }, 'all combinations'],
    [{ mode: 'combineBySql' }, 'SQL'],
  ])('treats %o as a boundary', (params) => {
    expect(() => run(params as Record<string, unknown>, [items({}), items({})])).toThrow(UnsupportedModeError);
  });

  it('treats suffix clash handling as a boundary rather than renaming keys badly', () => {
    expect(() =>
      run(
        {
          mode: 'combine',
          combineBy: 'combineByPosition',
          options: { clashHandling: { values: { resolveClash: 'addSuffix' } } },
        },
        [items({ a: 1 }), items({ a: 2 })],
      ),
    ).toThrow(UnsupportedModeError);
  });
});
