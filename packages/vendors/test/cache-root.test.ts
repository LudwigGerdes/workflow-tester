import { describe, expect, it } from 'vitest';
import { cacheRootFor } from '../src/ingest.js';

describe('the vendor cache root', () => {
  it('honours PAYLOAD_CONTRACT_CACHE', () => {
    expect(cacheRootFor({ PAYLOAD_CONTRACT_CACHE: '/somewhere' })).toBe('/somewhere/vendor-specs');
  });

  it('defaults under the home directory', () => {
    expect(cacheRootFor({})).toMatch(/\.payload-contract\/vendor-specs$/);
  });
});
