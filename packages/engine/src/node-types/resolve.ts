import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { INodeTypeDescription } from 'n8n-workflow';
import { cacheRoot, readStored } from './stored.js';

export type SourceKind = 'extracted' | 'bundled' | 'injected';

export interface Resolution {
  kind: SourceKind;
  /** The version whose descriptions were chosen. */
  version: string;
  /** The version that was asked for, when one was. */
  requested?: string;
  /** True only when the chosen version is the one that was asked for. */
  exact: boolean;
  /** Why it is not exact, for a report. Absent when it is. */
  note?: string;
  /**
   * Present for `extracted` and `injected` only.
   *
   * The bundle keeps its entries private and serves them through a
   * version-aware `describe(type, version)`. Flattening it here would need a
   * lookup keyed by name alone, which picks the wrong description for a node
   * shipping several versions — Set v2 against v3.4. So the bundle stays a pack
   * and `loadNodeTypes` uses it directly.
   */
  nodes?: INodeTypeDescription[];
}

export interface ResolveOptions {
  requested?: string;
  injected?: { version: string; nodes: INodeTypeDescription[] };
  /** Supplied by the caller so this file needs no bundle dependency. */
  bundled: (version?: string) => Promise<{ version: string; available: string[] }>;
  root?: string;
}

/**
 * Which descriptions to use, and how much to trust them.
 *
 * Injected wins outright — the caller was explicit, and this is how a custom
 * node gets described at all. Otherwise an exact extracted match, otherwise the
 * bundle. `exact` is what the walk uses to decide whether a missing required
 * parameter is a failure or only a warning.
 */
export async function resolveSource(options: ResolveOptions): Promise<Resolution> {
  const { requested, injected } = options;

  if (injected !== undefined) {
    return {
      kind: 'injected',
      version: injected.version,
      exact: true,
      nodes: injected.nodes,
      ...(requested === undefined ? {} : { requested }),
    };
  }

  let unreadable: string | undefined;
  if (requested !== undefined) {
    const dir = join(options.root ?? cacheRoot(), 'node-types', requested);
    const pack = readStored(dir);
    if (pack !== undefined) {
      return {
        kind: 'extracted',
        version: pack.meta.n8nVersion,
        requested,
        exact: true,
        nodes: pack.nodes,
      };
    }
    // Present but unreadable is different from absent: someone extracted this
    // version and it did not survive. Falling back silently would look like it
    // was never extracted at all.
    if (existsSync(dir)) unreadable = dir;
  }

  // No `nodes` from here on: the bundle stays a pack, and loadNodeTypes uses it.
  const bundle = await options.bundled(requested);
  const skipped = unreadable === undefined ? '' : ` (ignored an unreadable cache at ${unreadable})`;
  if (requested === undefined) {
    return {
      kind: 'bundled',
      version: bundle.version,
      exact: false,
      note: `no n8n version pinned; using bundled ${bundle.version}${skipped}`,
    };
  }
  if (bundle.version === requested) {
    return {
      kind: 'bundled',
      version: bundle.version,
      requested,
      exact: true,
      ...(unreadable === undefined ? {} : { note: `ignored an unreadable cache at ${unreadable}` }),
    };
  }

  // Say which way the substitution went. The old resolver called a higher
  // version "nearest", which reads as a floor it does not have.
  const older = bundle.available.filter((v) => compare(v, requested) <= 0);
  const note =
    older.length === 0
      ? `n8n ${requested} is older than anything bundled; using ${bundle.version}, which is newer`
      : `n8n ${requested} is not bundled; using the nearest older ${bundle.version}`;
  return { kind: 'bundled', version: bundle.version, requested, exact: false, note: `${note}${skipped}` };
}

/** Compare dotted versions numerically. -1, 0 or 1. */
function compare(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
