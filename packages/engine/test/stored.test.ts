import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cacheRoot, readStored, storedVersions } from '../src/node-types/stored.js';

const fixture = fileURLToPath(new URL('./fixtures/node-types/2.38.3', import.meta.url));

describe('readStored', () => {
  it('reads a version directory', () => {
    const pack = readStored(fixture);
    expect(pack?.meta.n8nVersion).toBe('2.38.3');
    expect(pack?.meta.libraryVersion).toBe('2.38.1');
    expect(pack?.nodes.map((n) => n.name).sort()).toEqual(['noOp', 'set']);
  });

  it('returns nothing for a directory that is not there', () => {
    expect(readStored(join(tmpdir(), 'workflow-tester-nope'))).toBeUndefined();
  });

  it('returns nothing rather than throwing on unreadable json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-tester-bad-'));
    writeFileSync(join(dir, 'meta.json'), '{ not json');
    writeFileSync(join(dir, 'nodes.json'), '[]');
    expect(readStored(dir)).toBeUndefined();
  });

  it('returns nothing when meta names no version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-tester-bad-'));
    writeFileSync(join(dir, 'meta.json'), '{"libraryVersion":"2.38.1"}');
    writeFileSync(join(dir, 'nodes.json'), '[]');
    expect(readStored(dir)).toBeUndefined();
  });

  it('returns nothing when nodes is not an array', () => {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-tester-bad-'));
    writeFileSync(join(dir, 'meta.json'), '{"n8nVersion":"2.38.3","libraryVersion":"2.38.1"}');
    writeFileSync(join(dir, 'nodes.json'), '{}');
    expect(readStored(dir)).toBeUndefined();
  });
});

describe('cacheRoot', () => {
  it('honours WORKFLOW_TESTER_CACHE', () => {
    expect(cacheRoot({ WORKFLOW_TESTER_CACHE: '/somewhere' })).toBe('/somewhere');
  });

  it('ignores WORKFLOW_TESTER_HOME, which means the checkout', () => {
    expect(cacheRoot({ WORKFLOW_TESTER_HOME: '/checkout' })).not.toBe('/checkout');
  });

  it('falls back to a directory under the home directory', () => {
    expect(cacheRoot({})).toMatch(/\.workflow-tester$/);
  });
});

describe('storedVersions', () => {
  it('lists the version directories under a root', () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-tester-root-'));
    for (const v of ['2.10.0', '2.38.3']) {
      mkdirSync(join(root, 'node-types', v), { recursive: true });
      writeFileSync(join(root, 'node-types', v, 'meta.json'),
        `{"n8nVersion":"${v}","libraryVersion":"${v}"}`);
      writeFileSync(join(root, 'node-types', v, 'nodes.json'), '[]');
    }
    expect(storedVersions(root)).toEqual(['2.10.0', '2.38.3']);
  });

  it('is empty when the root does not exist', () => {
    expect(storedVersions(join(tmpdir(), 'workflow-tester-absent'))).toEqual([]);
  });
});
