import { describe, expect, it } from 'vitest';
import { ImpureCallError } from '../src/types.js';

describe('ImpureCallError', () => {
  it('carries the node and the offending call', () => {
    const error = new ImpureCallError('Format Customer', '$helpers.httpRequest');
    expect(error.node).toBe('Format Customer');
    expect(error.call).toBe('$helpers.httpRequest');
  });

  it('names both in its message, which reaches the report', () => {
    const error = new ImpureCallError('Format Customer', '$helpers.httpRequest');
    expect(error.message).toContain('Format Customer');
    expect(error.message).toContain('$helpers.httpRequest');
  });

  it('is an Error, so an unhandled one still behaves', () => {
    expect(new ImpureCallError('n', 'c')).toBeInstanceOf(Error);
  });
});
