import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The data payload-contract ships, by what it is rather than where it lives.
 *
 * - `node-types`: n8n node descriptions, one directory per n8n version.
 * - `vendors`: `sources.yaml`, `AUDIT.md` and `data/<vendor>/<spec>/catalog.json`.
 * - `schema`: the test-file JSON Schema.
 */
export type DataKind = 'node-types' | 'vendors' | 'schema';

/** Where each kind lives in a checkout, relative to `packages/`. */
const IN_WORKSPACE: Record<DataKind, string[]> = {
  'node-types': ['engine', 'bundled'],
  vendors: ['vendors'],
  schema: ['runner', 'schema'],
};

/** Overrides every other layout; holds one directory per kind. */
export const DATA_ENV = 'PAYLOAD_CONTRACT_DATA';

export interface DataLayout {
  /** The directory of the module asking. Defaults to this one. */
  here?: string;
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
}

/**
 * The one place that knows where shipped data is. Three layouts, in order:
 *
 * 1. `PAYLOAD_CONTRACT_DATA=<dir>`: `<dir>/<kind>`, no questions asked.
 * 2. A checkout. This module sits at `packages/<pkg>/{src,dist}/` — as its own
 *    file under `packages/paths`, or bundled into `packages/cli/dist/` — so the
 *    sibling packages are two levels up, and the data is read where it is
 *    committed. Nothing is copied, so nothing can go stale.
 * 3. The installed package. The bundle is `<package>/dist/*.js` and `prepack`
 *    copied the data to `<package>/data/<kind>`.
 *
 * The checkout is recognised by two committed files that an installed package
 * never has beside it, so a stray `data/` left by an interrupted `pnpm pack`
 * cannot shadow the sources.
 */
export function dataDir(kind: DataKind, layout: DataLayout = {}): string {
  const env = layout.env ?? process.env;
  const exists = layout.exists ?? existsSync;
  const here = layout.here ?? dirname(fileURLToPath(import.meta.url));

  const override = env[DATA_ENV];
  if (override !== undefined && override !== '') return join(override, kind);

  const packages = join(here, '..', '..');
  const inCheckout =
    exists(join(packages, 'vendors', 'sources.yaml')) && exists(join(packages, 'engine', 'bundled'));
  if (inCheckout) return join(packages, ...IN_WORKSPACE[kind]);

  return join(here, '..', 'data', kind);
}
