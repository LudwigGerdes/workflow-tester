import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build the package before the suite runs. The sandbox executes the built
 * worker (see `src/sandbox/host.ts` for why a worker thread cannot load our
 * TypeScript), so the tests need `dist` to be current.
 */
export default function setup(): void {
  const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  // `workflow-test-paths` first: the built worker imports it from its `dist`.
  for (const dir of [join(packageDir, '..', 'paths'), packageDir]) {
    execFileSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json')], { stdio: 'inherit' });
  }
}
