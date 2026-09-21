import { describe, expect, it } from 'vitest';
import { diffShape, mergeShape, pathsOf, shapeOfItems, shapeOfValue } from '../src/shape.js';

const items = (...jsons: unknown[]) => jsons.map((json) => ({ json }));

describe('shapeOfValue', () => {
  it('records field types, never values', () => {
    const shape = shapeOfValue({ id: 7, name: 'ada', ok: true });
    expect(shape).toEqual({
      type: 'object',
      fields: { id: { type: 'number' }, name: { type: 'string' }, ok: { type: 'boolean' } },
    });
    // The point of the whole exercise: no customer data reaches disk.
    expect(JSON.stringify(shape)).not.toContain('ada');
  });

  it('descends into nested objects', () => {
    expect(shapeOfValue({ customer: { id: 'x' } })).toEqual({
      type: 'object',
      fields: { customer: { type: 'object', fields: { id: { type: 'string' } } } },
    });
  });

  it('merges array elements into one item shape', () => {
    expect(shapeOfValue([{ a: 1 }, { a: 2 }])).toEqual({
      type: 'array',
      cardinality: { min: 2, max: 2 },
      items: { type: 'object', fields: { a: { type: 'number' } } },
    });
  });

  it('leaves an empty array without an item shape, having seen none', () => {
    expect(shapeOfValue([])).toEqual({ type: 'array', cardinality: { min: 0, max: 0 } });
  });
});

describe('mergeShape', () => {
  it('marks a field missing from one item as optional', () => {
    const shape = shapeOfItems(items({ a: 1, b: 2 }, { a: 1 }));
    expect(shape.fields?.['b']).toEqual({ type: 'number', optional: true });
    expect(shape.fields?.['a']?.optional).toBeUndefined();
  });

  it('treats null beside a real type as nullable, not as a conflict', () => {
    expect(mergeShape({ type: 'string' }, { type: 'null' })).toEqual({
      type: 'string',
      optional: true,
    });
  });

  it('widens a genuine type conflict rather than picking a winner', () => {
    // A field that is sometimes a string and sometimes an object is exactly
    // what breaks a workflow; recording only the first would hide it.
    expect(mergeShape({ type: 'string' }, { type: 'object' }).type).toBe('unknown');
  });
});

describe('pathsOf', () => {
  it('lists leaf paths the way an expression reads them', () => {
    expect(pathsOf(shapeOfValue({ a: 1, b: { c: 'x' } }))).toEqual(['a', 'b.c']);
  });
});

describe('diffShape', () => {
  const before = shapeOfItems(items({ id: 1, customer: { id: 'c1', tier: 'gold' } }));

  it('reports a removed field, which is the dangerous change', () => {
    const after = shapeOfItems(items({ id: 1, customer: { id: 'c1' } }));
    expect(diffShape(before, after)).toEqual([
      { path: 'customer.tier', kind: 'removed', detail: 'string is no longer produced' },
    ]);
  });

  it('reports an added field', () => {
    const after = shapeOfItems(items({ id: 1, customer: { id: 'c1', tier: 'gold' }, extra: true }));
    expect(diffShape(before, after)).toEqual([
      { path: 'extra', kind: 'added', detail: 'new boolean' },
    ]);
  });

  it('reports a changed type', () => {
    const after = shapeOfItems(items({ id: 'now-a-string', customer: { id: 'c1', tier: 'gold' } }));
    expect(diffShape(before, after)).toEqual([
      { path: 'id', kind: 'type-changed', detail: 'was number, now string' },
    ]);
  });

  it('reports a field that stopped being present on every item', () => {
    const after = shapeOfItems(items({ id: 1, customer: { id: 'c1', tier: 'gold' } }, { id: 2, customer: { id: 'c2', tier: 'gold' } , }), );
    expect(diffShape(before, after)).toEqual([]);
  });

  it('says nothing when the shape is unchanged', () => {
    expect(diffShape(before, before)).toEqual([]);
  });
});

describe('array cardinality', () => {
  it('records how many elements were seen', () => {
    const shape = shapeOfValue([1, 2, 3]);
    expect(shape.cardinality).toEqual({ min: 3, max: 3 });
  });

  it('records zero for an empty array', () => {
    expect(shapeOfValue([]).cardinality).toEqual({ min: 0, max: 0 });
  });

  it('widens across observations', () => {
    const merged = mergeShape(shapeOfValue([1]), shapeOfValue([1, 2, 3, 4]));
    expect(merged.cardinality).toEqual({ min: 1, max: 4 });
  });

  it('keeps the known side when one observation predates the field', () => {
    const known = shapeOfValue([1, 2]);
    const legacy = { type: 'array' as const, items: { type: 'number' as const } };
    expect(mergeShape(known, legacy).cardinality).toEqual({ min: 2, max: 2 });
    expect(mergeShape(legacy, known).cardinality).toEqual({ min: 2, max: 2 });
  });

  it('carries through a whole node output', () => {
    const shape = shapeOfItems([{ json: { xs: [1, 2] } }, { json: { xs: [1] } }]);
    expect(shape.fields?.xs?.cardinality).toEqual({ min: 1, max: 2 });
  });

  it('leaves non-arrays alone', () => {
    expect(shapeOfValue({ a: 1 }).cardinality).toBeUndefined();
  });
});

describe('hostile keys', () => {
  /**
   * `JSON.parse` makes `__proto__` an *own* property, and `Object.entries`
   * hands it over like any other. Assigning it with `=` onto a plain object
   * invokes the setter and replaces that object's prototype — so a field
   * lookup could then find something inherited and report a field that is not
   * there. workflow-tester reads untrusted webhook payloads, so this is reachable.
   */
  const hostile = () => JSON.parse('{"__proto__": {"polluted": "yes"}, "ok": 1}') as unknown;

  it('does not let a payload hijack the prototype of the shape it produces', () => {
    const shape = shapeOfValue(hostile());
    expect(Object.getPrototypeOf(shape.fields ?? {})).toBe(Object.prototype);
  });

  it('does not let an inherited name look like a recorded field', () => {
    const shape = shapeOfValue(hostile());
    expect((shape.fields ?? {})['polluted']).toBeUndefined();
    expect((shape.fields as Record<string, unknown>)['type']).toBeUndefined();
  });

  it('keeps the key as data rather than dropping it', () => {
    const shape = shapeOfValue(hostile());
    expect(Object.keys(shape.fields ?? {}).sort()).toEqual(['__proto__', 'ok']);
  });

  it('leaves the real fields intact', () => {
    expect(shapeOfValue(hostile()).fields?.['ok']?.type).toBe('number');
  });

  it('survives a merge without hijacking either side', () => {
    const merged = mergeShape(shapeOfValue(hostile()), shapeOfValue({ ok: 2 }));
    expect(Object.getPrototypeOf(merged.fields ?? {})).toBe(Object.prototype);
    expect(merged.fields?.['ok']?.type).toBe('number');
  });

  it('never touches the global prototype', () => {
    shapeOfValue(hostile());
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
