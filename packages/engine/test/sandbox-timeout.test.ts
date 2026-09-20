import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEOUT_MS } from '../src/sandbox/host.js';

describe('the per-case sandbox timeout', () => {
  it('leaves room for a large run under load', () => {
    // Measured on a 200-case generated suite, four runs of an identical
    // repository at a 2000ms budget: 0, 9, 6 and 5 cases timed out. Nothing was
    // wrong with those cases — the budget was simply smaller than the spread of
    // worker startup under parallel load, which reads to a user as flakiness
    // and inflates the failure count.
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});
