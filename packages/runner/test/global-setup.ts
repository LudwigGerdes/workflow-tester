import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build `payload-contract-engine` before the suite runs. The sandbox executes the engine's
 * *built* worker (a worker thread cannot load our TypeScript), so the runner's
 * tests need the engine's dist to be current.
 */
export default function setup(): void {
  const engineDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'engine');
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  // `payload-contract-paths` first: the built worker imports it from its `dist`.
  for (const dir of [join(engineDir, '..', 'paths'), engineDir]) {
    execFileSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json')], { stdio: 'inherit' });
  }
}
