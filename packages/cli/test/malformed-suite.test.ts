import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/index.js';

let dir: string;
let out: string[];
let err: string[];
const io = () => ({ cwd: dir, out: (s: string) => out.push(s), err: (s: string) => err.push(s) });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-test-bad-'));
  out = [];
  err = [];
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  mkdirSync(join(dir, '.workflow-test/tests'), { recursive: true });
  writeFileSync(join(dir, 'workflows/w.json'), JSON.stringify({ id: 'w', nodes: [], connections: {} }));
});

/**
 * A malformed test file is a configuration mistake, and the tool says so in a
 * line someone can act on. Letting the error escape prints a Node stack trace
 * over the top of the actual message, which reads as the tool breaking rather
 * than the file being wrong.
 */
describe('a malformed test file', () => {
  it('exits 2 rather than throwing', async () => {
    writeFileSync(
      join(dir, '.workflow-test/tests/bad.test.yaml'),
      'workflow: ../../workflows/w.json\ncases:\n  - id: x\n    when:\n      trigger: Not A Kind\n',
    );
    await expect(run(['run'], io())).resolves.toBe(2);
  });

  it('names the file, the path and the line', async () => {
    writeFileSync(
      join(dir, '.workflow-test/tests/bad.test.yaml'),
      'workflow: ../../workflows/w.json\ncases:\n  - id: x\n    when:\n      trigger: Not A Kind\n',
    );
    await run(['run'], io());
    const text = err.join('\n');
    expect(text).toContain('bad.test.yaml');
    expect(text).toContain('/cases/0/when/trigger');
    expect(text).toMatch(/line 5/);
  });

  it('does the same for gen', async () => {
    writeFileSync(
      join(dir, '.workflow-test/tests/bad.test.yaml'),
      'workflow: ../../workflows/w.json\ncases:\n  - id: x\n    when:\n      trigger: Not A Kind\n',
    );
    await expect(run(['gen'], io())).resolves.not.toThrow();
  });
});
