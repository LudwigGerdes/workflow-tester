import { gunzipSync } from 'node:zlib';

/**
 * npm registry access, for extracting node descriptions.
 *
 * `fetch` is an argument rather than a global so every test runs against a stub
 * and the suite never makes a request — the same rule the instance client
 * follows. Nothing here runs unless a user asks for `node-types --version`.
 */

const REGISTRY = 'https://registry.npmjs.org';

/** Where n8n publishes every node description as one array. */
const DUMP_PATH = 'package/dist/types/nodes.json';

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

/**
 * Read one file out of an uncompressed tar archive.
 *
 * A tar is 512-byte header blocks, each followed by its file's bytes padded to
 * a multiple of 512. Only the name and size fields are needed, and the paths
 * involved are far short of the 100-byte limit, so long-name extensions do not
 * arise.
 */
export function readTarEntry(tar: Buffer, path: string): Buffer | undefined {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (name === '') return undefined; // two zero blocks end the archive

    const rawSize = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(rawSize, 8);
    if (!Number.isFinite(size) || size < 0) return undefined;

    const start = offset + 512;
    if (name === path) return tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

async function getJson(
  url: string,
  fetchImpl: typeof globalThis.fetch,
  what: string,
): Promise<unknown> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new RegistryError(`could not look up ${what} (${response.status} from the npm registry)`);
  }
  return await response.json();
}

/**
 * The library version an n8n release depends on.
 *
 * The app version is not the library version — n8n 2.38.3 ships
 * n8n-nodes-base 2.38.1 — and the `latest` tag on the library is unreliable, so
 * this is the only correct way to resolve it.
 */
export async function resolveLibraryVersion(
  app: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const body = await getJson(`${REGISTRY}/n8n/${app}`, fetchImpl, `n8n ${app}`);
  const dependencies = (body as { dependencies?: Record<string, string> }).dependencies ?? {};
  const version = dependencies['n8n-nodes-base'];
  if (typeof version !== 'string') {
    throw new RegistryError(`n8n ${app} does not declare a n8n-nodes-base dependency`);
  }
  return version;
}

/** Every node description n8n publishes for a library version. */
export async function fetchDescriptionDump(
  libraryVersion: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<unknown[]> {
  const body = await getJson(
    `${REGISTRY}/n8n-nodes-base/${libraryVersion}`,
    fetchImpl,
    `n8n-nodes-base ${libraryVersion}`,
  );
  const tarball = (body as { dist?: { tarball?: string } }).dist?.tarball;
  if (typeof tarball !== 'string') {
    throw new RegistryError(`n8n-nodes-base ${libraryVersion} has no tarball in the registry`);
  }

  const response = await fetchImpl(tarball);
  if (!response.ok) {
    throw new RegistryError(
      `could not download n8n-nodes-base ${libraryVersion} (${response.status})`,
    );
  }

  const entry = readTarEntry(gunzipSync(Buffer.from(await response.arrayBuffer())), DUMP_PATH);
  if (entry === undefined) {
    throw new RegistryError(
      `n8n-nodes-base ${libraryVersion} does not contain ${DUMP_PATH}; this n8n version cannot be extracted`,
    );
  }

  const parsed: unknown = JSON.parse(entry.toString('utf8'));
  if (!Array.isArray(parsed)) {
    throw new RegistryError(`${DUMP_PATH} in n8n-nodes-base ${libraryVersion} is not an array`);
  }
  return parsed;
}

/**
 * The n8n version a running instance reports, read from its own root page.
 *
 * n8n embeds its Sentry configuration as a base64 meta tag, and that carries
 * the release. No credential is involved — the page is served unauthenticated.
 *
 * This is an undocumented internal and will change without warning, so every
 * failure returns `undefined` and the caller asks for an explicit version.
 * Guessing would be worse than not knowing: the version silently decides which
 * parameters count as required.
 *
 * The decoded payload also contains a Sentry DSN. Only `release` is read, and
 * the payload is never echoed — an error message is the easiest way for a
 * credential to reach a log.
 */
export function detectVersion(html: string): string | undefined {
  // Attribute order and quoting vary, so find the tag first, then its content.
  const tag = html.match(/<meta[^>]*n8n:config:sentry[^>]*>/i)?.[0];
  const encoded = tag?.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
  if (encoded === undefined || encoded === '') return undefined;

  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const release = (JSON.parse(decoded) as { release?: unknown }).release;
    if (typeof release !== 'string') return undefined;
    const version = release.replace(/^n8n@/, '').trim();
    // A release that is not a version is not a version.
    return /^\d+\.\d+/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ask a running n8n which version it is.
 *
 * Unauthenticated: this reads the root page, not the api, so no key is needed
 * or accepted. Detection failing is a normal outcome rather than a crash — the
 * tag is an internal that may disappear — so the error says to pass
 * `--version` instead.
 */
export async function fetchInstanceVersion(
  url: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const root = `${url.replace(/\/+$/, '')}/`;
  const response = await fetchImpl(root);
  if (!response.ok) {
    throw new RegistryError(`could not reach ${root} (${response.status})`);
  }

  const version = detectVersion(await response.text());
  if (version === undefined) {
    throw new RegistryError(
      `could not detect the n8n version at ${root} — pass --version <n8n version> instead`,
    );
  }
  return version;
}
