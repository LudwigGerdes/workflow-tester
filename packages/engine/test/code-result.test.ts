import { describe, expect, it } from 'vitest';
import {
  CodeResultError,
  normalizeAllItems,
  normalizeEachItem,
} from '../src/semantics/code-result.js';

describe('normalizeAllItems', () => {
  it('wraps a bare array of objects', () => {
    expect(normalizeAllItems([{ a: 1 }, { a: 2 }], 'Code')).toEqual([
      { json: { a: 1 }, pairedItem: { item: 0 } },
      { json: { a: 2 }, pairedItem: { item: 0 } },
    ]);
  });

  it('passes through items already in {json} form', () => {
    expect(normalizeAllItems([{ json: { a: 1 } }], 'Code')).toEqual([
      { json: { a: 1 }, pairedItem: { item: 0 } },
    ]);
  });

  it('wraps a single object as one item', () => {
    expect(normalizeAllItems({ a: 1 }, 'Code')).toEqual([
      { json: { a: 1 }, pairedItem: { item: 0 } },
    ]);
  });

  it('keeps an empty array empty', () => {
    expect(normalizeAllItems([], 'Code')).toEqual([]);
  });

  // n8n rejects a non-object return rather than treating it as "no items", so
  // returning nothing is an error there and must be one here too.
  it('rejects no return value', () => {
    expect(() => normalizeAllItems(undefined, 'Code')).toThrow(CodeResultError);
  });

  it('rejects a primitive, which cannot be an item', () => {
    expect(() => normalizeAllItems(42, 'Code')).toThrow(CodeResultError);
  });

  it('rejects an array containing a primitive', () => {
    expect(() => normalizeAllItems([{ a: 1 }, 7], 'Code')).toThrow(CodeResultError);
  });

  it('rejects an item whose json is not an object', () => {
    expect(() => normalizeAllItems([{ json: 5 }], 'Code')).toThrow(CodeResultError);
  });

  // Accepting a key n8n refuses would let a mistake through silently.
  it('rejects an unknown key beside json', () => {
    expect(() => normalizeAllItems([{ json: { a: 1 }, oops: true }], 'Code')).toThrow(
      CodeResultError,
    );
  });

  it('allows the item keys n8n allows', () => {
    expect(normalizeAllItems([{ json: { a: 1 }, pairedItem: { item: 3 } }], 'Code')).toEqual([
      { json: { a: 1 }, pairedItem: { item: 3 } },
    ]);
  });

  it('names the node in the error, so a report can point at it', () => {
    expect(() => normalizeAllItems(42, 'Format Customer')).toThrow(/Format Customer/);
  });
});

describe('normalizeEachItem', () => {
  it('wraps a returned object and pairs it to its input', () => {
    expect(normalizeEachItem({ a: 1 }, 'Code', 2)).toEqual({
      json: { a: 1 },
      pairedItem: { item: 2 },
    });
  });

  it('passes through {json} form and still pairs it', () => {
    expect(normalizeEachItem({ json: { a: 1 } }, 'Code', 0)).toEqual({
      json: { a: 1 },
      pairedItem: { item: 0 },
    });
  });

  it('rejects an array, since each-item mode returns one item', () => {
    expect(() => normalizeEachItem([{ a: 1 }], 'Code', 0)).toThrow(CodeResultError);
  });

  it('rejects no return value', () => {
    expect(() => normalizeEachItem(undefined, 'Code', 0)).toThrow(CodeResultError);
  });
});
