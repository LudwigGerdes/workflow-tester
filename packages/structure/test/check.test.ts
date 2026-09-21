import { describe, expect, it } from 'vitest';
import type { Shape } from 'workflow-tester-contracts';
import { checkChain } from '../src/check.js';
import type { Chain } from '../src/chain.js';

const field = (name: string): Chain[number] => ({ kind: 'field', name });
const index = (i: number): Chain[number] => ({ kind: 'index', index: i });

const shape: Shape = {
  type: 'object',
  fields: {
    items: {
      type: 'array',
      cardinality: { min: 5, max: 5 },
      items: { type: 'object', fields: { sku: { type: 'string' } } },
    },
    user: {
      type: 'object',
      fields: { name: { type: 'string' }, nick: { type: 'string', optional: true } },
    },
    count: { type: 'number' },
  },
};

describe('checkChain', () => {
  it('passes a chain that matches the shape', () => {
    expect(checkChain(shape, [field('user'), field('name')])).toEqual([]);
  });

  it('reports reading a field off an array', () => {
    const [finding] = checkChain(shape, [field('items'), field('sku')]);
    expect(finding?.kind).toBe('container-mismatch');
    expect(finding?.severity).toBe('fail');
    expect(finding?.at).toBe('items');
    expect(finding?.message).toContain('array');
  });

  it('reports indexing an object', () => {
    const [finding] = checkChain(shape, [field('user'), index(0)]);
    expect(finding?.kind).toBe('container-mismatch');
    expect(finding?.severity).toBe('fail');
  });

  it('reports reading a field off a scalar', () => {
    const [finding] = checkChain(shape, [field('count'), field('value')]);
    expect(finding?.kind).toBe('container-mismatch');
  });

  it('warns on a field the shape does not carry', () => {
    const [finding] = checkChain(shape, [field('user'), field('email')]);
    expect(finding?.kind).toBe('absent-field');
    // Never a failure: a `??` fallback reads a path that is absent by design,
    // and n8n's own contract is that an unresolved value warns.
    expect(finding?.severity).toBe('warn');
    expect(finding?.at).toBe('user.email');
  });

  it('warns rather than fails on a field the shape marks optional', () => {
    const findings = checkChain(shape, [field('user'), field('nick')]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('absent-field');
    expect(findings[0]?.severity).toBe('warn');
  });

  it('descends into array elements', () => {
    expect(checkChain(shape, [field('items'), index(0), field('sku')])).toEqual([]);
  });

  it('stops walking after an absent field rather than cascading', () => {
    const findings = checkChain(shape, [field('nope'), field('deeper'), field('deeper still')]);
    expect(findings).toHaveLength(1);
  });

  it('says nothing about an unknown shape', () => {
    expect(checkChain({ type: 'unknown' }, [field('anything')])).toEqual([]);
  });
});

describe('index-out-of-range', () => {
  it('warns when the index is past every observed length', () => {
    const [finding] = checkChain(shape, [field('items'), index(7), field('sku')]);
    expect(finding?.kind).toBe('index-out-of-range');
    expect(finding?.severity).toBe('warn');
    expect(finding?.at).toBe('items[7]');
    expect(finding?.message).toContain('5');
  });

  it('keeps walking after the warning, since the element shape is still known', () => {
    const findings = checkChain(shape, [field('items'), index(7), field('nope')]);
    expect(findings.map((f) => f.kind)).toEqual(['index-out-of-range', 'absent-field']);
  });

  it('says nothing when the index is within the observed range', () => {
    expect(checkChain(shape, [field('items'), index(4), field('sku')])).toEqual([]);
  });

  it('says nothing when cardinality was never recorded', () => {
    const legacy: Shape = {
      type: 'object',
      fields: { xs: { type: 'array', items: { type: 'string' } } },
    };
    expect(checkChain(legacy, [field('xs'), index(99)])).toEqual([]);
  });
});
