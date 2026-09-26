import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import type { Io } from '../src/io.js';

const repo = (yaml?: string): Io => {
  const cwd = mkdtempSync(join(tmpdir(), 'workflow-tester-cfg-'));
  if (yaml !== undefined) {
    mkdirSync(join(cwd, '.workflow-tester'), { recursive: true });
    writeFileSync(join(cwd, '.workflow-tester', 'config.yaml'), yaml);
  }
  return { cwd, env: {}, out: () => {}, err: () => {} };
};

describe('readConfig', () => {
  it('reads the pinned n8n version', () => {
    expect(readConfig(repo('n8nVersion: 2.38.3\n')).n8nVersion).toBe('2.38.3');
  });

  it('reads testsDirs, and ignores a malformed one', () => {
    expect(readConfig(repo('testsDirs: [workflows, tests/flows]\n')).testsDirs).toEqual(['workflows', 'tests/flows']);
    expect(readConfig(repo('testsDirs: workflows\n')).testsDirs).toBeUndefined();
    expect(readConfig(repo('testsDirs: []\n')).testsDirs).toBeUndefined();
  });

  it('is empty when there is no config at all', () => {
    expect(readConfig(repo()).n8nVersion).toBeUndefined();
  });

  it('is empty rather than throwing when the file is malformed', () => {
    // A broken config must not stop a run: the floor still works.
    expect(readConfig(repo('n8nVersion: [this is not a version\n')).n8nVersion).toBeUndefined();
  });

  it('ignores a version that is not one', () => {
    expect(readConfig(repo('n8nVersion: latest\n')).n8nVersion).toBeUndefined();
  });

  it('accepts a quoted version', () => {
    expect(readConfig(repo('n8nVersion: "2.10.0"\n')).n8nVersion).toBe('2.10.0');
  });
});
