import type { INodeType, INodeTypeDescription, INodeTypes } from 'n8n-workflow';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from 'workflow-tester-paths';
import { SUPPORTED_N8N_VERSION } from './version.js';
import { readStored } from './node-types/stored.js';
import { resolveSource, type Resolution } from './node-types/resolve.js';

/**
 * What the engine needs from the node-type bundle: an `INodeTypes` that
 * `Workflow` and `NodeHelpers` accept, plus the bundle's non-throwing lookups.
 */
export interface NodeTypeSource extends INodeTypes {
  /** The n8n release the loaded descriptions were extracted from. */
  readonly n8nVersion: string;
  /** True only when the descriptions are for the version that was asked for. */
  readonly exact: boolean;
  /** The version that was asked for, when one was. */
  readonly requestedVersion?: string;
  /** Why the match is not exact. Absent when it is. */
  readonly sourceNote?: string;
  /**
   * False only when no descriptions could be found at all — the bundled floor
   * is missing and nothing was extracted or injected. The walk then keeps its
   * built-in semantics for pure nodes and skips required-parameter checks,
   * which need a description to be a claim about anything.
   */
  readonly hasDescriptions: boolean;
  describe(nodeType: string, version?: number): INodeTypeDescription | undefined;
  versionsOf(nodeType: string): { versions: number[]; defaultVersion: number } | undefined;
  isDeprecated(nodeType: string, version?: number): boolean;
  getByNameAndVersion(nodeType: string, version?: number): INodeType;
}

/**
 * Where the committed floor lives: `packages/engine/bundled` in a checkout,
 * `data/node-types` inside the installed package. `dataDir` knows which.
 */
function floorRoot(override?: string): string {
  return override ?? dataDir('node-types');
}

/** Versions the floor ships. One, today. */
function floorVersions(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Load the node descriptions for `version`.
 *
 * Descriptions come from one of three sources — injected, extracted into the
 * cache, or the floor committed inside this package — and the result says which
 * it was and whether the version matched. Nothing here reaches the network:
 * extracting a version is a separate, explicit act.
 */
export async function loadNodeTypes(
  version: string = SUPPORTED_N8N_VERSION,
  options: {
    injected?: { version: string; nodes: INodeTypeDescription[] };
    root?: string;
    /** Where the committed floor lives. Tests point it at an empty directory. */
    floor?: string;
  } = {},
): Promise<NodeTypeSource> {
  const floorDir = floorRoot(options.floor);
  const resolution = await resolveSource({
    requested: version,
    ...(options.injected === undefined ? {} : { injected: options.injected }),
    ...(options.root === undefined ? {} : { root: options.root }),
    bundled: async (requested) => {
      const available = floorVersions(floorDir);
      // One floor version: it is what you get, and `resolveSource` decides
      // whether that counts as exact and which way the substitution went.
      const version =
        requested !== undefined && available.includes(requested)
          ? requested
          : (available[available.length - 1] ?? SUPPORTED_N8N_VERSION);
      return { version, available };
    },
  });

  const meta = {
    exact: resolution.exact,
    ...(resolution.requested === undefined ? {} : { requestedVersion: resolution.requested }),
    ...(resolution.note === undefined ? {} : { sourceNote: resolution.note }),
  };

  if (resolution.nodes !== undefined) {
    return {
      ...meta,
      n8nVersion: resolution.version,
      hasDescriptions: true,
      ...fromDescriptions(resolution.nodes),
    };
  }

  const floor = readStored(join(floorDir, resolution.version));
  if (floor === undefined) {
    // The tool still runs without n8n's descriptions: expressions, Code nodes
    // and the pure-node semantics consult none of them. What is lost is the
    // required-parameter check, and the run says so rather than failing.
    return {
      ...meta,
      exact: false,
      n8nVersion: resolution.version,
      hasDescriptions: false,
      sourceNote:
        `no node descriptions found for n8n ${resolution.version} (nothing bundled in ${floorDir}); ` +
        'pure nodes run on their built-in semantics and required-parameter checks are skipped — ' +
        "run 'workflow-tester node-types --version <v>' to extract a set, or 'pnpm bundle:node-types' in a checkout",
      ...fromDescriptions([]),
    };
  }
  return {
    ...meta,
    n8nVersion: floor.meta.n8nVersion,
    hasDescriptions: true,
    ...fromDescriptions(floor.nodes),
  };
}

/** Every version entry a description covers. */
const versionsIn = (d: INodeTypeDescription): number[] =>
  Array.isArray(d.version) ? d.version : [d.version];

/** Wrap a description the way `lookup` does, or hand back undefined. */
const asNodeType = (description: INodeTypeDescription | undefined): INodeType =>
  (description === undefined ? undefined : { description }) as unknown as INodeType;

/**
 * The same lookups over descriptions read from disk or injected.
 *
 * Keyed by name *and* version because a node ships several entries — Set v2 and
 * v3.4 are different descriptions — and a lookup by name alone would hand back
 * whichever happened to be last.
 */
function fromDescriptions(
  nodes: INodeTypeDescription[],
): Omit<NodeTypeSource, 'n8nVersion' | 'exact' | 'requestedVersion' | 'sourceNote' | 'hasDescriptions'> {
  const byName = new Map<string, INodeTypeDescription[]>();
  const add = (key: string, d: INodeTypeDescription): void => {
    byName.set(key, [...(byName.get(key) ?? []), d]);
  };
  for (const d of nodes) {
    add(d.name, d);
    if (!d.name.includes('.')) add(`n8n-nodes-base.${d.name}`, d);
  }

  const describe = (type: string, version?: number): INodeTypeDescription | undefined => {
    const candidates = byName.get(type);
    if (candidates === undefined || candidates.length === 0) return undefined;
    if (version === undefined) return candidates[candidates.length - 1];
    return candidates.find((d) => versionsIn(d).includes(version)) ?? candidates[candidates.length - 1];
  };

  return {
    describe,
    versionsOf: (type) => {
      const candidates = byName.get(type);
      if (candidates === undefined || candidates.length === 0) return undefined;
      const versions = candidates.flatMap(versionsIn).sort((a, b) => a - b);
      const defaultVersion = versions[versions.length - 1];
      return defaultVersion === undefined ? undefined : { versions, defaultVersion };
    },
    isDeprecated: () => false,
    getByName: (type) => asNodeType(describe(type)),
    getKnownTypes: () => Object.fromEntries([...byName.keys()].map((k) => [k, {}])),
    /**
     * Non-throwing by design. `INodeTypes` declares this as returning
     * `INodeType`, but n8n's own `Workflow` constructor tests the result for
     * `undefined` and skips the node when it is — its comment notes that
     * erroring instead "causes problems with expression resolution ... when the
     * unknown node does not get used". Returning `undefined` matches n8n's
     * runtime contract and is what lets the walker turn an unknown type into a
     * boundary rather than an error.
     */
    getByNameAndVersion: (type, v) => asNodeType(describe(type, v)),
  };
}
