import { describe, expect, it } from 'vitest';
import { loadNodeTypes } from '../src/node-types.js';
import { SUPPORTED_N8N_VERSION } from '../src/version.js';

/**
 * A characterization test, not a specification.
 *
 * Every assertion here held against the private bundle and must still hold
 * against the committed floor — that is the whole claim of the swap: the
 * source changes, nothing observable does.
 */
describe('the bundled floor', () => {
  it('serves the supported version exactly, with no dependency and no network', async () => {
    const types = await loadNodeTypes();
    expect(types.n8nVersion).toBe(SUPPORTED_N8N_VERSION);
    expect(types.exact).toBe(true);
  });

  it('describes a node the engine interprets, per version', async () => {
    // Version-aware: Set ships as separate v2 and v3 descriptions.
    const types = await loadNodeTypes();
    expect(types.describe('n8n-nodes-base.set', 3.4)?.name).toBe('n8n-nodes-base.set');
    expect(types.describe('n8n-nodes-base.set', 2)?.name).toBe('n8n-nodes-base.set');
    expect(types.describe('n8n-nodes-base.set', 3.4)).not.toEqual(
      types.describe('n8n-nodes-base.set', 2),
    );
  });

  it('still hands back undefined for an unknown type, so it becomes a boundary', async () => {
    const types = await loadNodeTypes();
    expect(types.getByNameAndVersion('n8n-nodes-base.notARealNode', 1)).toBeUndefined();
  });

  it('reports a version it does not have as inexact, naming the direction', async () => {
    const types = await loadNodeTypes('99.0.0');
    expect(types.exact).toBe(false);
    expect(types.requestedVersion).toBe('99.0.0');
    expect(types.sourceNote).toMatch(/99\.0\.0/);
  });
});
