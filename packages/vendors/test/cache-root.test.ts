import { describe, expect, it } from 'vitest';
import { cacheRootFor } from '../src/ingest.js';

describe('the vendor cache root', () => {
  it('honours WORKFLOW_TESTER_CACHE', () => {
    expect(cacheRootFor({ WORKFLOW_TESTER_CACHE: '/somewhere' })).toBe('/somewhere/vendor-specs');
  });

  it('defaults under the home directory', () => {
    expect(cacheRootFor({})).toMatch(/\.workflow-tester\/vendor-specs$/);
  });
});
