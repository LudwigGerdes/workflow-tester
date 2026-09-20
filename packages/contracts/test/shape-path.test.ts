import { describe, expect, it } from 'vitest';
import { shapeOfValue, shapeHasPath } from '../src/shape.js';

const shape = shapeOfValue({
  body: { email: 'a@x.io', items: [{ sku: 'A' }], nested: { deep: 1 } },
});

describe('shapeHasPath', () => {
  it('finds a plain field', () => {
    expect(shapeHasPath(shape, 'body.email')).toBe(true);
    expect(shapeHasPath(shape, 'body.nested.deep')).toBe(true);
  });

  it('walks into array elements', () => {
    expect(shapeHasPath(shape, 'body.items[].sku')).toBe(true);
  });

  it('says no for a field that is not there', () => {
    expect(shapeHasPath(shape, 'body.missing')).toBe(false);
    expect(shapeHasPath(shape, 'body.items[].gone')).toBe(false);
  });

  it('says no when a field is read as an array but is not one', () => {
    expect(shapeHasPath(shape, 'body.email[].x')).toBe(false);
  });
});
