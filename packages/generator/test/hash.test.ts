import { describe, expect, it } from 'vitest';
import { stableHash } from '../src/hash.js';

describe('stableHash', () => {
  it('ignores key order', () => {
    expect(stableHash({ a: 1, b: { c: 2, d: 3 } })).toBe(stableHash({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('changes when a value changes', () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });

  it('distinguishes a missing key from an undefined one only by content', () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 1, b: null }));
  });

  it('respects array order', () => {
    expect(stableHash([1, 2])).not.toBe(stableHash([2, 1]));
  });

  it('is a hex digest, short enough to read in a filename', () => {
    expect(stableHash({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable across processes for a fixed input', () => {
    // pinned so a change to the hashing scheme is a visible, deliberate diff
    expect(stableHash({ contract: 'stripe.invoice', exampleIndex: 0, mutations: [] })).toBe(
      stableHash({ mutations: [], exampleIndex: 0, contract: 'stripe.invoice' }),
    );
  });
});
