// Puts everything the published package needs beside its `dist/` for the
// duration of `pnpm pack` / `pnpm publish`, and removes it afterwards:
//
//   LICENSE, README.md, THIRD_PARTY_NOTICES.md   from the repo root
//   data/node-types/   ← packages/engine/bundled        (n8n node descriptions)
//   data/vendors/      ← packages/vendors/{sources.yaml,AUDIT.md,data/}
//   data/schema/       ← packages/runner/schema
//
// The copies are gitignored. The layout under data/ is the one
// `workflow-tester-paths` resolves when the code is not running in a checkout.
// Usage, from packages/cli: node ../../scripts/pack-files.mjs pre|post
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'packages', 'cli');
const phase = process.argv[2];

const copies = [
  ['LICENSE', 'LICENSE'],
  ['README.md', 'README.md'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ['packages/engine/bundled', 'data/node-types'],
  ['packages/vendors/sources.yaml', 'data/vendors/sources.yaml'],
  ['packages/vendors/AUDIT.md', 'data/vendors/AUDIT.md'],
  ['packages/vendors/data', 'data/vendors/data'],
  ['packages/runner/schema', 'data/schema'],
];

if (phase !== 'pre' && phase !== 'post') {
  console.error('usage: pack-files.mjs pre|post');
  process.exit(2);
}

rmSync(join(pkgDir, 'data'), { recursive: true, force: true });
for (const [from, to] of copies) {
  const target = join(pkgDir, to);
  if (phase === 'pre') {
    if (!existsSync(join(root, from))) throw new Error(`pack-files: ${from} is missing`);
    cpSync(join(root, from), target, { recursive: true });
  } else {
    rmSync(target, { recursive: true, force: true });
  }
}

if (phase === 'pre' && !existsSync(join(pkgDir, 'dist', 'sandbox-worker.js'))) {
  throw new Error('pack-files: packages/cli/dist is not built — run `pnpm build` first');
}
