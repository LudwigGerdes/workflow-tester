// Builds the one published package: every internal workspace library bundled
// into `dist/`, every third-party dependency left external.
//
//   dist/bin.js             the CLI
//   dist/sandbox-worker.js  the sandbox worker, loaded by path from a worker
//                           thread (packages/engine/src/sandbox/host.ts)
//   dist/chunk-*.js         code the two share, so there is one copy of it
//
// Workspace libraries are bundled from their TypeScript sources (the
// `development` export condition), so the sourcemaps point at real files.
import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const declared = Object.keys(manifest.dependencies ?? {});
const builtins = new Set(builtinModules);

const packageName = (specifier) =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];

/**
 * Bare specifiers are either ours (bundle them), declared in `dependencies`
 * (leave them external), or a mistake: an undeclared import would resolve in
 * the workspace and then fail for everyone who installs the tarball.
 */
const externals = {
  name: 'declared-externals',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('node:') || builtins.has(args.path)) return { path: args.path, external: true };
      const name = packageName(args.path);
      if (name.startsWith('workflow-tester-')) return undefined;
      if (declared.includes(name)) return { path: args.path, external: true };
      return {
        errors: [{ text: `"${args.path}" is imported by ${args.importer} but "${name}" is not in packages/cli dependencies` }],
      };
    });
  },
};

rmSync(join(pkgDir, 'dist'), { recursive: true, force: true });

await build({
  absWorkingDir: pkgDir,
  entryPoints: {
    bin: 'src/bin.ts',
    'sandbox-worker': '../engine/src/sandbox/worker.ts',
  },
  outdir: 'dist',
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  conditions: ['development'],
  chunkNames: 'chunk-[hash]',
  plugins: [externals],
  logLevel: 'info',
});

chmodSync(join(pkgDir, 'dist', 'bin.js'), 0o755);
