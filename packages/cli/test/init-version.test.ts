import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initCommand, runCommand } from '../src/commands/run.js';
import type { Io } from '../src/io.js';

const sink = () => {
  const lines: string[] = [];
  const io: Io = {
    cwd: mkdtempSync(join(tmpdir(), 'workflow-tester-init-')),
    env: {},
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
  };
  return { lines, io };
};

describe('init and the n8n version', () => {
  it('writes a config when given a version', async () => {
    const { io } = sink();
    expect(await initCommand(io, ['--n8n-version', '2.38.3'])).toBe(0);
    expect(readFileSync(join(io.cwd, '.workflow-tester', 'config.yaml'), 'utf8')).toMatch(
      /n8nVersion: 2\.38\.3/,
    );
  });

  it('writes no config when the question is skipped', async () => {
    // Skip is a real answer: the bundled descriptions work.
    const { io } = sink();
    expect(await initCommand(io, ['--no-ask'])).toBe(0);
    expect(existsSync(join(io.cwd, '.workflow-tester', 'config.yaml'))).toBe(false);
  });

  it('never blocks when stdin is not a terminal', async () => {
    // The suite is not a tty, so a bare init must return rather than wait.
    const { lines, io } = sink();
    expect(await initCommand(io)).toBe(0);
    expect(lines.join('\n')).toMatch(/n8n version/i);
  });

  it('still scaffolds the example test', async () => {
    const { io } = sink();
    await initCommand(io, ['--no-ask']);
    expect(existsSync(join(io.cwd, '.workflow-tester', 'tests', 'example.test.yaml'))).toBe(true);
  });

  it('rejects a version that is not one', async () => {
    const { lines, io } = sink();
    expect(await initCommand(io, ['--n8n-version', 'latest'])).toBe(2);
    expect(lines.join('\n')).toMatch(/latest/);
  });
});

describe('the scaffolded example', () => {
  it('does not fail the first run after init', async () => {
    // The example points at a workflow the user has not written yet. Shipping
    // it live means the first thing a new user sees is a red line they did not
    // cause, which teaches them to ignore red lines.
    const { io } = sink();
    expect(await initCommand(io, ['--no-ask'])).toBe(0);
    expect(await runCommand([], io)).toBe(0);
  });
});
