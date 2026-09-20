import { describe, expect, it } from 'vitest';
import { impliedRequirements } from '../src/requirements.js';
import { readChain } from '../src/chain.js';

describe('impliedRequirements', () => {
  it('reads the requirements out of a deep chain', () => {
    const code = '$json.array1[68].kypairs.body.properties[17][5].name';
    const chain = readChain(code, '$json'.length);
    expect(chain).toBeDefined();
    expect(impliedRequirements(chain ?? [])).toEqual([
      { at: '(root)', kind: 'has-field', detail: 'array1' },
      { at: 'array1', kind: 'min-length', detail: '69' },
      { at: 'array1[68]', kind: 'has-field', detail: 'kypairs' },
      { at: 'array1[68].kypairs', kind: 'has-field', detail: 'body' },
      { at: 'array1[68].kypairs.body', kind: 'has-field', detail: 'properties' },
      { at: 'array1[68].kypairs.body.properties', kind: 'min-length', detail: '18' },
      { at: 'array1[68].kypairs.body.properties[17]', kind: 'min-length', detail: '6' },
      { at: 'array1[68].kypairs.body.properties[17][5]', kind: 'has-field', detail: 'name' },
    ]);
  });

  it('returns nothing for an empty chain', () => {
    expect(impliedRequirements([])).toEqual([]);
  });
});
