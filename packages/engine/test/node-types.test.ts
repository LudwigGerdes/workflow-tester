import { describe, expect, it } from 'vitest';
import type { INodeTypeDescription } from 'n8n-workflow';
import { loadNodeTypes } from '../src/node-types.js';

const node = (name: string) =>
  ({ displayName: name, name, version: 1, inputs: ['main'], outputs: ['main'], properties: [] }) as unknown as INodeTypeDescription;

describe('loadNodeTypes exactness', () => {
  it('is exact for the version it bundles', async () => {
    const bundled = await loadNodeTypes();
    const source = await loadNodeTypes(bundled.n8nVersion);
    expect(source.exact).toBe(true);
    expect(source.sourceNote).toBeUndefined();
  });

  it('is inexact for a version it does not have, and says so', async () => {
    const source = await loadNodeTypes('99.0.0');
    expect(source.exact).toBe(false);
    expect(source.requestedVersion).toBe('99.0.0');
    expect(source.sourceNote).toMatch(/99\.0\.0/);
  });

  it('takes an injected source and calls it exact', async () => {
    const source = await loadNodeTypes('2.38.3', {
      injected: { version: '2.38.3', nodes: [node('myCustomNode')] },
    });
    expect(source.exact).toBe(true);
    expect(source.describe('myCustomNode')).toBeDefined();
  });

  it('still answers the lookups the walk depends on', async () => {
    const source = await loadNodeTypes();
    expect(source.describe('n8n-nodes-base.set')).toBeDefined();
    expect(source.n8nVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('hands back undefined for an unknown type rather than throwing', async () => {
    // What turns an unknown node into a boundary instead of an error.
    const source = await loadNodeTypes('2.38.3', {
      injected: { version: '2.38.3', nodes: [node('known')] },
    });
    expect(source.getByNameAndVersion('n8n-nodes-base.notAThing')).toBeUndefined();
  });

  it('picks the description covering a requested typeVersion', async () => {
    const v2 = { ...node('multi'), version: 2 } as INodeTypeDescription;
    const v3 = { ...node('multi'), version: 3.4, displayName: 'newer' } as INodeTypeDescription;
    const source = await loadNodeTypes('2.38.3', {
      injected: { version: '2.38.3', nodes: [v2, v3] },
    });
    expect(source.describe('multi', 2)?.version).toBe(2);
    expect(source.describe('multi', 3.4)?.version).toBe(3.4);
  });
});
