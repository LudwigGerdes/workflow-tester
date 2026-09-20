import { describe, expect, it } from 'vitest';
import { shapeOfItems } from '../src/shape.js';
import { synthesize, synthesizeItems } from '../src/synthesize.js';

const shapeOf = (json: unknown) => shapeOfItems([{ json }]);

describe('synthesize', () => {
  it('builds a value for every recorded field', () => {
    const out = synthesize(shapeOf({ id: 1, name: 'ada', ok: true })) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['id', 'name', 'ok']);
    expect(typeof out['id']).toBe('number');
    expect(typeof out['name']).toBe('string');
    expect(typeof out['ok']).toBe('boolean');
  });

  it('descends into nested objects, so a deep read resolves', () => {
    const out = synthesize(shapeOf({ customer: { id: 'c1' } })) as { customer: { id: unknown } };
    expect(out.customer.id).toBeDefined();
  });

  it('puts one element in an array, so map and [0] both find something', () => {
    const out = synthesize(shapeOf({ items: [{ sku: 'a' }] })) as { items: unknown[] };
    expect(out.items).toHaveLength(1);
    expect((out.items[0] as { sku: unknown }).sku).toBeDefined();
  });

  it('is deterministic, so a case does not move between runs', () => {
    const shape = shapeOf({ a: 'x', b: { c: 'y' } });
    expect(synthesize(shape)).toEqual(synthesize(shape));
  });

  it('invents values and says so in them', () => {
    const out = synthesize(shapeOf({ email: 'ada@x.io' })) as { email: string };
    expect(out.email).toContain('email');
    expect(out.email).not.toContain('ada@x.io');
  });
});

describe('synthesizeItems', () => {
  it('returns one item wrapping the value as json', () => {
    const items = synthesizeItems(shapeOf({ id: 1 }));
    expect(items).toHaveLength(1);
    expect(items[0]?.json).toHaveProperty('id');
  });
});
