import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { enumerateMutations } from '../src/schema-walk.js';
import { applyMutation } from '../src/mutate.js';

const load = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

const schema = load('record.schema.json');
const example = load('record.example.json') as Record<string, unknown>;

/** Everything in the example is read by the workflow, except the buried subtree. */
const FOCUS = new Set([
  'record',
  'record.name',
  'record.details.name',
  'email',
  'phone',
  'status',
  'items',
  'items[].sku',
  'created',
]);

const describeAll = (mutations: ReturnType<typeof enumerateMutations>): string[] =>
  mutations.map((m) => `${m.kind} ${m.path} ${m.detail}`.trim()).sort();

describe('enumerateMutations', () => {
  it('drops optional properties but never required ones', () => {
    const found = describeAll(enumerateMutations(schema, example, { focus: FOCUS }));
    expect(found).toContain('optional-absent email');
    expect(found).toContain('optional-absent phone');
    // record and status are required by the schema
    expect(found).not.toContain('optional-absent record');
    expect(found).not.toContain('optional-absent status');
  });

  it('nulls a nullable property', () => {
    expect(describeAll(enumerateMutations(schema, example, { focus: FOCUS }))).toContain(
      'nullable-null phone',
    );
  });

  it('offers every enum member except the one already there', () => {
    const found = describeAll(enumerateMutations(schema, example, { focus: FOCUS }));
    expect(found).toContain('enum-value status cancelled');
    expect(found).toContain('enum-value status paused');
    expect(found).not.toContain('enum-value status active');
  });

  it('varies array cardinality, skipping the count the example already has', () => {
    const found = describeAll(enumerateMutations(schema, example, { focus: FOCUS }));
    expect(found).toContain('array-cardinality items 0');
    expect(found).toContain('array-cardinality items 3');
    // the example already holds exactly one item, so a "1" mutation would
    // reproduce the example case verbatim — waste, not coverage
    expect(found).not.toContain('array-cardinality items 1');
  });

  it('generates the single-element case when the example holds several', () => {
    const many = { ...example, items: [{ sku: 'A-1' }, { sku: 'B-2' }] };
    const found = describeAll(enumerateMutations(schema, many, { focus: FOCUS }));
    expect(found).toContain('array-cardinality items 1');
    expect(found).toContain('array-cardinality items 0');
    expect(found).toContain('array-cardinality items 3');
  });

  it('produces one case per oneOf branch', () => {
    const branches = enumerateMutations(schema, example, { focus: FOCUS }).filter(
      (m) => m.kind === 'oneOf-branch',
    );
    expect(branches).toHaveLength(2);
    expect(branches.every((b) => b.path === 'record')).toBe(true);
  });

  it('synthesises the branch the examples do not cover, and says so', () => {
    const branches = enumerateMutations(schema, example, { focus: FOCUS }).filter(
      (m) => m.kind === 'oneOf-branch',
    );
    // the example covers `record.name`; nothing covers `record.details.name`
    const covered = branches.find((b) => b.detail.includes('0'));
    const missing = branches.find((b) => b.detail.includes('1'));
    expect(covered?.synthesized).toBeFalsy();
    expect(missing?.synthesized).toBe(true);

    // and this is the case that catches the bug the spec names
    const payload = applyMutation(example, missing!) as { record: { details: { name: unknown } } };
    expect(payload.record.details.name).toBeDefined();
    expect(payload.record).not.toHaveProperty('name');
  });

  it('uses a real example fragment for a branch some example does covers', () => {
    const other = { ...example, record: { details: { name: 'Grace' } } };
    const branches = enumerateMutations(schema, example, {
      focus: FOCUS,
      examples: [example, other],
    }).filter((m) => m.kind === 'oneOf-branch');
    const second = branches.find((b) => b.detail.includes('1'));
    expect(second?.synthesized).toBeFalsy();
    expect(applyMutation(example, second!)).toMatchObject({ record: { details: { name: 'Grace' } } });
  });

  it('varies string formats at their edges', () => {
    const found = describeAll(enumerateMutations(schema, example, { focus: FOCUS }));
    expect(found.some((f) => f.startsWith('format-edge email'))).toBe(true);
    expect(found.some((f) => f.startsWith('format-edge created'))).toBe(true);
  });

  it('respects overrides.required by not dropping the path', () => {
    const found = describeAll(
      enumerateMutations(schema, example, { focus: FOCUS, overrides: { required: ['email'] } }),
    );
    expect(found).not.toContain('optional-absent email');
    expect(found).toContain('optional-absent phone');
  });

  it('respects overrides.never by skipping the subtree entirely', () => {
    const found = describeAll(
      enumerateMutations(schema, example, { focus: FOCUS, overrides: { never: ['items'] } }),
    );
    expect(found.some((f) => f.includes('items'))).toBe(false);
  });

  it('does not descend into a subtree nothing reads', () => {
    const found = describeAll(enumerateMutations(schema, example, { focus: FOCUS }));
    // `unread` may be dropped wholesale, but nothing below it is worth varying
    expect(found).toContain('optional-absent unread');
    expect(found.some((f) => f.includes('unread.deep.buried'))).toBe(false);
  });

  it('is deterministic', () => {
    const once = describeAll(enumerateMutations(schema, example, { focus: FOCUS }));
    const twice = describeAll(enumerateMutations(schema, example, { focus: FOCUS }));
    expect(once).toEqual(twice);
  });
});

describe('applyMutation', () => {
  it('never mutates the payload it is given', () => {
    const [first] = enumerateMutations(schema, example, { focus: FOCUS });
    const before = JSON.stringify(example);
    applyMutation(example, first!);
    expect(JSON.stringify(example)).toBe(before);
  });

  it('removes the property for optional-absent', () => {
    const drop = enumerateMutations(schema, example, { focus: FOCUS }).find(
      (m) => m.kind === 'optional-absent' && m.path === 'email',
    );
    expect(applyMutation(example, drop!)).not.toHaveProperty('email');
  });

  it('empties and fills arrays for array-cardinality', () => {
    const mutations = enumerateMutations(schema, example, { focus: FOCUS });
    const zero = mutations.find((m) => m.kind === 'array-cardinality' && m.detail === '0');
    const three = mutations.find((m) => m.kind === 'array-cardinality' && m.detail === '3');
    expect((applyMutation(example, zero!) as { items: unknown[] }).items).toEqual([]);
    expect((applyMutation(example, three!) as { items: unknown[] }).items).toHaveLength(3);
  });
});
