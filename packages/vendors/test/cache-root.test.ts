import { describe, expect, it } from 'vitest';
import { cacheRootFor } from '../src/ingest.js';

describe('the vendor cache root', () => {
  it('honours WORKFLOW_TEST_CACHE', () => {
    expect(cacheRootFor({ WORKFLOW_TEST_CACHE: '/somewhere' })).toBe('/somewhere/vendor-specs');
  });

  it('defaults under the home directory', () => {
    expect(cacheRootFor({})).toMatch(/\.workflow-test\/vendor-specs$/);
  });
});
