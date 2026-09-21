import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generate } from '../src/generate.js';
import type { Case } from '../src/types.js';

const load = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

const schema = load('record.schema.json');
const example = load('record.example.json') as Record<string, unknown>;

const FOCUS = new Set([
  'record', 'record.name', 'record.details.name', 'email', 'phone', 'status', 'items', 'items[].sku', 'created',
]);

const run = (overrides: Partial<Parameters<typeof generate>[0]> = {}) =>
  generate({
    schema,
    examples: [{ event: 'record.updated', payload: example }],
    focus: FOCUS,
    contractKey: 'test.record',
    ...overrides,
  });

/** A mutation matters if the workflow reads that path or something beneath it. */
const touchesFocus = (path: string): boolean =>
  [...FOCUS].some((f) => f === path || f.startsWith(`${path}.`) || f.startsWith(`${path}[`));

const isExample = (c: Case): boolean => c.tags.includes('example');
const mutationCount = (c: Case): number => c.provenance.mutations.length;
const inFocus = (c: Case): boolean => c.provenance.mutations.some((m) => touchesFocus(m.path));

describe('the case budget', () => {
  it('derives from node count, and is far smaller than the old flat cap', () => {
    expect(run({ nodeCount: 3 }).cases.length).toBeLessThan(run().cases.length);
  });

  it('lets an explicit max override the node-count budget', () => {
    const { cases } = run({ nodeCount: 3, max: 40 });
    expect(cases.length).toBeGreaterThan(run({ nodeCount: 3 }).cases.length);
  });
});

describe('what the budget is spent on', () => {
  it('never pairs two mutations the workflow reads neither of', () => {
    // Neither half can change behaviour, so the pair cannot distinguish
    // anything. These were 62% of the candidates on a real workflow.
    for (const c of run({ max: 10_000 }).cases) {
      if (mutationCount(c) < 2) continue;
      expect(inFocus(c)).toBe(true);
    }
  });

  it('keeps every single mutation on a read path, however small the budget', () => {
    // The floor: workflow-test must not silently stop testing a field the workflow's
    // own expressions read.
    const all = run({ max: 10_000 }).cases;
    const wanted = all.filter((c) => !isExample(c) && mutationCount(c) === 1 && inFocus(c)).map((c) => c.id);
    const kept = new Set(run({ nodeCount: 1 }).cases.map((c) => c.id));
    for (const id of wanted) expect(kept.has(id)).toBe(true);
  });

  it('orders read-path singles before pairs, and non-focus last', () => {
    const cases = run({ max: 10_000 }).cases;
    const lastFocusSingle = cases.findLastIndex((c) => !isExample(c) && mutationCount(c) === 1 && inFocus(c));
    const firstPair = cases.findIndex((c) => mutationCount(c) === 2);
    const firstNonFocus = cases.findIndex((c) => !isExample(c) && !inFocus(c));
    expect(lastFocusSingle).toBeLessThan(firstPair);
    expect(firstPair).toBeLessThan(firstNonFocus);
  });

  it('puts nullable-null first among read-path singles, where the defects are', () => {
    const cases = run({ max: 10_000 }).cases.filter((c) => !isExample(c) && mutationCount(c) === 1 && inFocus(c));
    const lastNullable = cases.findLastIndex((c) => c.provenance.mutations[0]?.kind === 'nullable-null');
    const firstOther = cases.findIndex((c) => c.provenance.mutations[0]?.kind !== 'nullable-null');
    if (lastNullable !== -1 && firstOther !== -1) expect(lastNullable).toBeLessThan(firstOther);
  });
});

describe('pairs of nulls', () => {
  // Two independently nullable objects: each handled alone, both at once is
  // where an interaction bug lives.
  const schema2 = {
    type: 'object',
    properties: {
      a: { type: ['object', 'null'], properties: { x: { type: 'string' } } },
      b: { type: ['object', 'null'], properties: { y: { type: 'string' } } },
    },
  };
  const example2 = { a: { x: 'p' }, b: { y: 'q' } };
  const gen2 = (max: number) =>
    generate({
      schema: schema2,
      examples: [{ event: 'e', payload: example2 }],
      focus: new Set(['a', 'a.x', 'b', 'b.y']),
      contractKey: 'k2',
      max,
    }).cases;

  const isPair = (c: Case): boolean => c.provenance.mutations.length === 2;
  const bothNull = (c: Case): boolean =>
    isPair(c) && c.provenance.mutations.every((m) => m.kind === 'nullable-null');

  it('generates the both-null pair at all', () => {
    expect(gen2(10_000).some(bothNull)).toBe(true);
  });

  it('ranks it ahead of other pairs', () => {
    const cases = gen2(10_000);
    const first = cases.findIndex(bothNull);
    const otherPair = cases.findIndex((c) => isPair(c) && !bothNull(c));
    expect(first).toBeGreaterThanOrEqual(0);
    if (otherPair !== -1) expect(first).toBeLessThan(otherPair);
  });

  it('keeps it when the budget only has room for one pair', () => {
    // The whole point: a tight budget must spend it on the pair most likely to
    // find something, not on whichever sorted first.
    const floorOnly = gen2(10_000).filter((c) => !isPair(c)).length;
    expect(gen2(floorOnly + 1).some(bothNull)).toBe(true);
  });
});
