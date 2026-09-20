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

describe('generate', () => {
  it('always emits every example verbatim', () => {
    const { cases, stats } = run();
    const examples = cases.filter((c) => c.tags.includes('example'));
    expect(examples).toHaveLength(1);
    expect(examples[0]?.payload).toEqual(example);
    expect(examples[0]?.event).toBe('record.updated');
    expect(stats.examples).toBe(1);
  });

  it('emits one case per single mutation', () => {
    const { cases, stats } = run();
    const singles = cases.filter((c) => c.provenance.mutations.length === 1);
    expect(singles.length).toBe(stats.single);
    expect(singles.length).toBeGreaterThan(5);
  });

  it('names a case after what it changed', () => {
    const { cases } = run();
    const dropped = cases.find(
      (c) => c.provenance.mutations[0]?.kind === 'optional-absent' && c.provenance.mutations[0]?.path === 'email',
    );
    expect(dropped?.title).toContain('optional-absent');
    expect(dropped?.title).toContain('email');
  });

  it('combines mutations pairwise over distinct paths', () => {
    const { cases, stats } = run();
    const pairs = cases.filter((c) => c.provenance.mutations.length === 2);
    expect(pairs.length).toBe(stats.pairs);
    expect(pairs.length).toBeGreaterThan(0);
    for (const pair of pairs) {
      const [a, b] = pair.provenance.mutations;
      expect(a?.path).not.toBe(b?.path);
      // never combine a path with one nested inside it
      expect(b?.path.startsWith(`${a?.path ?? ''}.`)).toBe(false);
      expect(a?.path.startsWith(`${b?.path ?? ''}.`)).toBe(false);
    }
  });

  it('gives every case a content-hash id, unique across the set', () => {
    const { cases } = run();
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[0-9a-f]{16}$/.test(id))).toBe(true);
  });

  it('orders examples first, then singles, then pairs', () => {
    const { cases } = run();
    const rank = (c: Case): number => (c.tags.includes('example') ? 0 : c.provenance.mutations.length);
    const ranks = cases.map(rank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  it('is deterministic across runs', () => {
    expect(run().cases).toEqual(run().cases);
  });

  it('is deterministic regardless of focus-set iteration order', () => {
    const reversed = new Set([...FOCUS].reverse());
    expect(run({ focus: reversed }).cases.map((c) => c.id)).toEqual(run().cases.map((c) => c.id));
  });

  it('honours the cap and reports what it discarded', () => {
    const capped = run({ max: 12 });
    expect(capped.cases).toHaveLength(12);
    expect(capped.stats.truncated).toBeGreaterThan(0);
    // the examples are never the thing dropped
    expect(capped.cases.filter((c) => c.tags.includes('example'))).toHaveLength(1);
  });

  it('covers every focus optional, nullable and oneOf branch at least once', () => {
    const { cases } = run();
    const covered = new Set(
      cases.flatMap((c) => c.provenance.mutations.map((m) => `${m.kind} ${m.path}`)),
    );
    expect(covered).toContain('optional-absent email');
    expect(covered).toContain('nullable-null phone');
    expect(covered).toContain('oneOf-branch record');
  });

  it('applies each mutation to the payload it records', () => {
    const { cases } = run();
    // several single mutations touch `email`; this is the one that removes it
    const dropped = cases.find(
      (c) =>
        c.provenance.mutations.length === 1 &&
        c.provenance.mutations[0]?.path === 'email' &&
        c.provenance.mutations[0]?.kind === 'optional-absent',
    );
    expect(dropped?.payload).not.toHaveProperty('email');
    const nulled = cases.find(
      (c) => c.provenance.mutations.length === 1 && c.provenance.mutations[0]?.kind === 'nullable-null',
    );
    expect((nulled?.payload as { phone: unknown }).phone).toBeNull();
  });

  it('carries mutation provenance without the function that made it', () => {
    const { cases } = run();
    const single = cases.find((c) => c.provenance.mutations.length === 1);
    expect(single?.provenance.mutations[0]).not.toHaveProperty('apply');
    expect(single?.provenance.mutations[0]).toMatchObject({ kind: expect.any(String), path: expect.any(String) });
  });

  it('generates from several examples, tagging each with its event', () => {
    const { cases, stats } = run({
      examples: [
        { event: 'a', payload: example },
        { event: 'b', payload: { ...example, status: 'paused' } },
      ],
    });
    expect(stats.examples).toBe(2);
    expect(cases.filter((c) => c.tags.includes('example')).map((c) => c.event)).toEqual(['a', 'b']);
  });
});
