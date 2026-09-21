import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { INodeTypeDescription } from 'n8n-workflow';
import { resolveSource } from '../src/node-types/resolve.js';

const node = (name: string) =>
  ({ displayName: name, name, version: 1, inputs: ['main'], outputs: ['main'], properties: [] }) as unknown as INodeTypeDescription;

/** A cache root holding the given versions. */
const rootWith = (...versions: string[]): string => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-test-res-'));
  for (const v of versions) {
    mkdirSync(join(root, 'node-types', v), { recursive: true });
    writeFileSync(join(root, 'node-types', v, 'meta.json'),
      `{"n8nVersion":"${v}","libraryVersion":"${v}"}`);
    writeFileSync(join(root, 'node-types', v, 'nodes.json'),
      JSON.stringify([node(`from-${v}`)]));
  }
  return root;
};

const bundled = (version = '2.10.0', available = ['2.10.0']) =>
  async () => ({ version, available });

describe('resolveSource', () => {
  it('prefers an extracted version that matches exactly', async () => {
    const r = await resolveSource({ requested: '2.38.3', bundled: bundled(), root: rootWith('2.38.3') });
    expect(r.kind).toBe('extracted');
    expect(r.version).toBe('2.38.3');
    expect(r.exact).toBe(true);
    expect(r.note).toBeUndefined();
    expect(r.nodes?.[0]?.name).toBe('from-2.38.3');
  });

  it('falls back to the bundle when nothing is extracted', async () => {
    const r = await resolveSource({ requested: '2.38.3', bundled: bundled(), root: rootWith() });
    expect(r.kind).toBe('bundled');
    expect(r.version).toBe('2.10.0');
    expect(r.exact).toBe(false);
    expect(r.note).toMatch(/2\.38\.3/);
    // the bundle is not flattened, so the resolver carries no nodes for it
    expect(r.nodes).toBeUndefined();
  });

  it('is exact when the bundle happens to be the requested version', async () => {
    const r = await resolveSource({ requested: '2.10.0', bundled: bundled(), root: rootWith() });
    expect(r.kind).toBe('bundled');
    expect(r.exact).toBe(true);
  });

  it('is not exact when nothing was requested, since nothing was matched', async () => {
    const r = await resolveSource({ bundled: bundled(), root: rootWith() });
    expect(r.exact).toBe(false);
    expect(r.note).toMatch(/pinned/i);
  });

  it('lets an injected source win outright', async () => {
    const r = await resolveSource({
      requested: '2.38.3',
      injected: { version: 'custom', nodes: [node('mine')] },
      bundled: bundled(),
      root: rootWith('2.38.3'),
    });
    expect(r.kind).toBe('injected');
    expect(r.exact).toBe(true);
    expect(r.nodes?.[0]?.name).toBe('mine');
    expect(r.nodes).toHaveLength(1);
  });

  it('says the direction when every bundled version is above the request', async () => {
    const r = await resolveSource({
      requested: '2.9.0',
      bundled: bundled('2.10.0', ['2.10.0']),
      root: rootWith(),
    });
    expect(r.exact).toBe(false);
    expect(r.note).toMatch(/newer|above|later/i);
  });

  it('ignores an extracted directory for a different version', async () => {
    const r = await resolveSource({ requested: '2.38.3', bundled: bundled(), root: rootWith('2.9.0') });
    expect(r.kind).toBe('bundled');
  });
});

describe('an extracted cache that cannot be read', () => {
  it('says so rather than falling back silently', async () => {
    // Absent and corrupt are different situations, and a report that treats
    // them the same hides the fact that someone extracted this version.
    const root = mkdtempSync(join(tmpdir(), 'workflow-test-resolve-'));
    mkdirSync(join(root, 'node-types', '2.10.0'), { recursive: true });
    writeFileSync(join(root, 'node-types', '2.10.0', 'nodes.json'), 'not json at all');

    const resolution = await resolveSource({
      requested: '2.10.0',
      root,
      bundled: async () => ({ version: '2.10.0', available: ['2.10.0'] }),
    });

    expect(resolution.kind).toBe('bundled');
    expect(resolution.note).toMatch(/unreadable/);
  });
});
