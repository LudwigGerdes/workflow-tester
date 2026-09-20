import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { INodeTypeDescription } from 'n8n-workflow';

/** What an extraction recorded about itself. */
export interface StoredMeta {
  n8nVersion: string;
  /** The library the descriptions came from: n8n@2.38.3 ships n8n-nodes-base@2.38.1. */
  libraryVersion: string;
  extractedAt?: string;
  source?: string;
}

export interface StoredPack {
  meta: StoredMeta;
  nodes: INodeTypeDescription[];
}

/**
 * Where extracted descriptions live.
 *
 * `PAYLOAD_CONTRACT_CACHE`, deliberately not `PAYLOAD_CONTRACT_HOME` — that one already names the
 * payload-contract checkout for `scripts/payload-contract.sh`, and pointing a cache at a source
 * tree would be a silent, confusing failure.
 */
export function cacheRoot(env: Record<string, string | undefined> = process.env): string {
  return env['PAYLOAD_CONTRACT_CACHE'] ?? join(homedir(), '.payload-contract');
}

/**
 * Read one version directory, or nothing.
 *
 * Nothing rather than throwing: a corrupt or half-written cache must fall back
 * to the bundled descriptions, not end the run.
 */
export function readStored(dir: string): StoredPack | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as StoredMeta;
    const nodes = JSON.parse(readFileSync(join(dir, 'nodes.json'), 'utf8')) as unknown;
    if (typeof meta?.n8nVersion !== 'string' || typeof meta?.libraryVersion !== 'string') {
      return undefined;
    }
    if (!Array.isArray(nodes)) return undefined;
    return { meta, nodes: nodes as INodeTypeDescription[] };
  } catch {
    return undefined;
  }
}

/** Version directories present under a cache root, sorted. */
export function storedVersions(root: string = cacheRoot()): string[] {
  const dir = join(root, 'node-types');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && readStored(join(dir, e.name)) !== undefined)
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
