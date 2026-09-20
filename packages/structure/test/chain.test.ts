import { describe, expect, it } from 'vitest';
import { readChain, renderChain, toFocusSegments } from '../src/chain.js';

/** Read a chain starting just past the root token. */
const chainOf = (code: string) => readChain(code, code.indexOf('$json') + '$json'.length);

describe('readChain', () => {
  it('reads a plain dotted chain', () => {
    expect(chainOf('$json.body.name')).toEqual([
      { kind: 'field', name: 'body' },
      { kind: 'field', name: 'name' },
    ]);
  });

  it('keeps the literal index rather than normalising it', () => {
    expect(chainOf('$json.items[7].name')).toEqual([
      { kind: 'field', name: 'items' },
      { kind: 'index', index: 7 },
      { kind: 'field', name: 'name' },
    ]);
  });

  it('reads consecutive indices', () => {
    expect(chainOf('$json.grid[17][5]')).toEqual([
      { kind: 'field', name: 'grid' },
      { kind: 'index', index: 17 },
      { kind: 'index', index: 5 },
    ]);
  });

  it('reads a quoted bracket key as a field', () => {
    expect(chainOf("$json.body['odd key']")).toEqual([
      { kind: 'field', name: 'body' },
      { kind: 'field', name: 'odd key' },
    ]);
  });

  it('tolerates optional chaining', () => {
    expect(chainOf('$json?.body?.name')).toEqual([
      { kind: 'field', name: 'body' },
      { kind: 'field', name: 'name' },
    ]);
  });

  it('stops before a method call', () => {
    expect(chainOf('$json.body.name.toUpperCase()')).toEqual([
      { kind: 'field', name: 'body' },
      { kind: 'field', name: 'name' },
    ]);
  });

  it('refuses a computed key', () => {
    expect(chainOf('$json.body[key]')).toBeUndefined();
  });

  it('refuses an empty chain', () => {
    expect(chainOf('$json')).toBeUndefined();
  });
});

describe('renderChain', () => {
  it('renders fields and indices readably', () => {
    const chain = chainOf('$json.items[7].name');
    expect(chain).toBeDefined();
    expect(renderChain(chain ?? [])).toBe('items[7].name');
  });
});

describe('toFocusSegments', () => {
  it('collapses every index to the array itself', () => {
    const chain = chainOf('$json.grid[17][5].name');
    expect(toFocusSegments(chain ?? [])).toEqual(['grid[][]', 'name']);
  });

  it('refuses a chain that indexes before naming anything', () => {
    const chain = readChain('$json[0].name', '$json'.length);
    expect(chain).toBeDefined();
    expect(toFocusSegments(chain ?? [])).toBeUndefined();
  });
});
