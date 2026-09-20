import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { dataDir } from 'payload-contract-paths';
import type { Catalog, Sources, VendorSource } from './types.js';

export * from './types.js';

/** `packages/vendors` in a checkout, `data/vendors` inside the installed package. */
const PACKAGE_DIR = dataDir('vendors');
const DATA_DIR = join(PACKAGE_DIR, 'data');
const SOURCES_FILE = join(PACKAGE_DIR, 'sources.yaml');
const AUDIT_FILE = join(PACKAGE_DIR, 'AUDIT.md');

export class UnknownVendorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownVendorError';
  }
}

let sourcesCache: Sources | undefined;

/** The committed source manifest: where each vendor's webhooks come from. */
export function loadSources(): Sources {
  sourcesCache ??= parse(readFileSync(SOURCES_FILE, 'utf8')) as Sources;
  return sourcesCache;
}

export function listVendors(): string[] {
  return Object.keys(loadSources().vendors);
}

export function vendorSource(vendor: string): VendorSource | undefined {
  return loadSources().vendors[vendor];
}

/**
 * Order spec versions by their numeric parts, so `1.10.0` sorts after `1.1.4`
 * and Stripe's date-and-codename releases order chronologically. Vendors do not
 * agree on a versioning scheme, and a plain string sort gets both wrong.
 */
export function compareSpecVersions(a: string, b: string): number {
  const chunks = (v: string): Array<string | number> =>
    (v.match(/\d+|\D+/g) ?? []).map((part) => (/^\d+$/.test(part) ? Number(part) : part));

  const left = chunks(a);
  const right = chunks(b);

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (typeof l === 'number' && typeof r === 'number') {
      if (l !== r) return l - r;
    } else {
      const compared = String(l).localeCompare(String(r));
      if (compared !== 0) return compared;
    }
  }
  return 0;
}

/** Spec versions with a committed catalog, oldest first. */
export function catalogVersions(vendor: string): string[] {
  const dir = join(DATA_DIR, vendor);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'catalog.json')))
    .map((entry) => entry.name)
    .sort(compareSpecVersions);
}

export function latestSpecVersion(vendor: string): string | undefined {
  return catalogVersions(vendor).at(-1);
}

const catalogCache = new Map<string, Catalog>();

/**
 * Load a vendor's committed catalog. Offline by construction: this reads only
 * files in the package, never the network. `pnpm ingest` is what refreshes them.
 */
export function loadCatalog(vendor: string, specVersion?: string): Catalog {
  const source = vendorSource(vendor);
  if (source === undefined) {
    throw new UnknownVendorError(
      `unknown vendor "${vendor}" (known: ${listVendors().join(', ')})`,
    );
  }
  if (source.kind === 'none') {
    throw new UnknownVendorError(
      `vendor "${vendor}" publishes nothing machine-readable, so it has no catalog — see AUDIT.md`,
    );
  }

  const version = specVersion ?? latestSpecVersion(vendor);
  if (version === undefined) {
    throw new UnknownVendorError(`vendor "${vendor}" has no catalog; run \`pnpm ingest\``);
  }

  const key = `${vendor}@${version}`;
  const cached = catalogCache.get(key);
  if (cached !== undefined) return cached;

  const file = join(DATA_DIR, vendor, version, 'catalog.json');
  if (!existsSync(file)) {
    throw new UnknownVendorError(
      `no catalog for ${vendor}@${version} (have: ${catalogVersions(vendor).join(', ') || 'none'})`,
    );
  }
  const catalog = JSON.parse(readFileSync(file, 'utf8')) as Catalog;
  catalogCache.set(key, catalog);
  return catalog;
}

/**
 * The generated per-vendor coverage audit. Exposed as a function so consumers
 * never have to resolve a path inside this package.
 */
export function readAudit(): string {
  return readFileSync(AUDIT_FILE, 'utf8');
}
