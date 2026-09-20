import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = resolve(CLI, '..');

/** `fs.globSync` is Node 22+; and the package now requires Node >= 24, but plain readdir keeps this portable. */
const jsFilesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.js'));

/** Only real module specifiers — prose inside a doc comment is not an import. */
const SPECIFIERS = [
  /^\s*(?:import|export)\b[^;\n]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  // esbuild renames a `createRequire` result to `require2`, `require3`, …
  /\brequire\d*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const bareName = (spec: string): string =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] ?? spec);

function bareImports(distDir: string): Set<string> {
  const found = new Set<string>();
  for (const js of jsFilesUnder(distDir)) {
    const src = readFileSync(join(distDir, js), 'utf8');
    for (const pattern of SPECIFIERS) {
      for (const m of src.matchAll(pattern)) {
        const spec = m[1] ?? '';
        if (spec === '' || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
        found.add(bareName(spec));
      }
    }
  }
  return found;
}

const dependenciesOf = (dir: string): string[] =>
  Object.keys(
    (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> })
      .dependencies ?? {},
  );

/**
 * Every module the published bundle imports must be one the published package
 * declares. The workspace hoists everything, so an undeclared import works
 * here and is fatal for anyone who installs the tarball; only a check against
 * the *declared* dependencies catches that.
 */
describe('the published package declares what its bundle imports', () => {
  beforeAll(() => {
    execFileSync(process.execPath, [join(CLI, 'scripts', 'build.mjs')], { stdio: 'pipe' });
  });

  it('ships the CLI and the sandbox worker as entry points', () => {
    expect(existsSync(join(CLI, 'dist', 'bin.js'))).toBe(true);
    expect(existsSync(join(CLI, 'dist', 'sandbox-worker.js'))).toBe(true);
  });

  it('imports nothing undeclared', () => {
    const declared = new Set(dependenciesOf(CLI));
    const undeclared = [...bareImports(join(CLI, 'dist'))].filter((name) => !declared.has(name));
    expect(undeclared.sort()).toEqual([]);
  });

  it('has no internal workspace library left to resolve', () => {
    const internal = [...bareImports(join(CLI, 'dist'))].filter((name) => name.startsWith('payload-contract'));
    expect(internal).toEqual([]);
    expect(dependenciesOf(CLI).filter((name) => name.startsWith('payload-contract'))).toEqual([]);
  });

  it('declares nothing it does not import', () => {
    const imported = bareImports(join(CLI, 'dist'));
    expect(dependenciesOf(CLI).filter((name) => !imported.has(name))).toEqual([]);
  });
});

describe('each workspace library declares what it imports', () => {
  const libraries = readdirSync(PACKAGES, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'cli' && existsSync(join(PACKAGES, d.name, 'package.json')))
    .map((d) => d.name)
    .sort();

  for (const name of libraries) {
    it(`${name} imports nothing undeclared`, () => {
      const distDir = join(PACKAGES, name, 'dist');
      if (!existsSync(distDir)) return; // not built in this run
      const declared = new Set(dependenciesOf(join(PACKAGES, name)));
      expect([...bareImports(distDir)].filter((dep) => !declared.has(dep)).sort()).toEqual([]);
    });
  }
});
