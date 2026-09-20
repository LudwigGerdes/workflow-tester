import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const engineDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'engine');

/** The most recently modified source file under a directory. */
function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const mtime = entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

/**
 * The e2e cases run through the sandbox, and the sandbox executes the engine's
 * *built* worker — a worker thread cannot load our TypeScript. Nothing else in
 * this package would notice a stale build: the tests would quietly exercise
 * whatever was last compiled and report failures, or passes, that have nothing
 * to do with the source under test.
 */
describe('the sandbox worker the e2e cases run', () => {
  it('is built from the current engine source', () => {
    const built = statSync(join(engineDir, 'dist', 'sandbox', 'worker.js')).mtimeMs;
    expect(built).toBeGreaterThanOrEqual(newestMtime(join(engineDir, 'src')));
  });
});
