import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build `workflow-tester-engine` before the suite runs.
 *
 * The e2e cases run through the sandbox, and the sandbox executes the engine's
 * *built* worker — a worker thread cannot load our TypeScript. Without this the
 * suite silently exercises whatever was last compiled: a stale build makes
 * every e2e case report findings that have nothing to do with the source under
 * test, which reads as an intermittent failure rather than the deterministic
 * one it is. `packages/engine` and `packages/runner` already do this; this
 * package spawns the same worker and needs the same guarantee.
 */
export default function setup(): void {
  const engineDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'engine');
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  // `workflow-tester-paths` first: the built worker imports it from its `dist`.
  for (const dir of [join(engineDir, '..', 'paths'), engineDir]) {
    execFileSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json')], { stdio: 'inherit' });
  }
}
