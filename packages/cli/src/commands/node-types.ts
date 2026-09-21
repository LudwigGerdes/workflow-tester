import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SUPPORTED_N8N_VERSION, cacheRoot, harvest } from 'workflow-tester-engine';
import {
  fetchDescriptionDump,
  fetchInstanceVersion,
  resolveLibraryVersion,
} from 'workflow-tester-instance';
import { EXIT, parseArgs, type Io } from '../io.js';
import { readConfig } from '../config.js';

/**
 * Extract the node descriptions workflow-tester reads, for one n8n version.
 *
 * `--version` is the only path that reaches the network, and only when run.
 * `--from` is entirely offline and is how a custom node gets described.
 */
export async function nodeTypesCommand(
  argv: string[],
  io: Io,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<number> {
  // `parseArgs` is the house flag parser; every other command uses it.
  const { flags } = parseArgs(argv);
  const version = typeof flags['version'] === 'string' ? flags['version'] : undefined;
  const from = typeof flags['from'] === 'string' ? flags['from'] : undefined;
  const instance = typeof flags['instance'] === 'string' ? flags['instance'] : undefined;

  const list = flags['list'] !== undefined;

  const unknown = Object.keys(flags).find(
    (name) => name !== 'version' && name !== 'from' && name !== 'instance' && name !== 'list',
  );
  if (unknown !== undefined) {
    io.err(`workflow-tester: node-types does not take --${unknown}`);
    return EXIT.usage;
  }
  if (list) {
    if ([version, from, instance].some((value) => value !== undefined)) {
      io.err('workflow-tester: --list takes no other flags; it only reports what is available');
      return EXIT.usage;
    }
    return listSources(io);
  }
  if ([version, from, instance].filter((value) => value !== undefined).length !== 1) {
    io.err(
      'workflow-tester: node-types needs exactly one of --version <n8n version>, --instance <url> or --from <dir>',
    );
    return EXIT.usage;
  }

  // `cacheRoot` already reads WORKFLOW_TESTER_CACHE; `?? {}` keeps a developer's own
  // exported value out of the tests.
  const root = join(cacheRoot(io.env ?? {}), 'node-types');

  try {
    // Detection is unauthenticated by design: it reads the instance's own root
    // page, so no api key is asked for or accepted.
    const resolved =
      instance === undefined ? version : await fetchInstanceVersion(instance, fetchImpl);

    const extracted =
      from === undefined
        ? await fromRegistry(resolved as string, fetchImpl)
        : fromDirectory(from);

    if (extracted.nodes.length === 0) {
      io.err(`workflow-tester: no usable node descriptions found (${extracted.source})`);
      return EXIT.usage;
    }

    const dir = join(root, extracted.n8nVersion);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'meta.json'),
      `${JSON.stringify(
        {
          n8nVersion: extracted.n8nVersion,
          libraryVersion: extracted.libraryVersion,
          extractedAt: new Date().toISOString(),
          source: extracted.source,
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(dir, 'nodes.json'), `${JSON.stringify(extracted.nodes)}\n`);

    io.out(`n8n ${extracted.n8nVersion}: ${extracted.nodes.length} node descriptions written to ${dir}`);
    return EXIT.ok;
  } catch (error) {
    io.err(`workflow-tester: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.usage;
  }
}

interface Extracted {
  n8nVersion: string;
  libraryVersion: string;
  nodes: ReturnType<typeof harvest>;
  source: string;
}

async function fromRegistry(app: string, fetchImpl: typeof globalThis.fetch): Promise<Extracted> {
  const libraryVersion = await resolveLibraryVersion(app, fetchImpl);
  const dump = await fetchDescriptionDump(libraryVersion, fetchImpl);
  return {
    n8nVersion: app,
    libraryVersion,
    nodes: harvest(dump),
    source: `n8n-nodes-base@${libraryVersion}`,
  };
}

function fromDirectory(dir: string): Extracted {
  const root = resolve(dir);
  const nodesFile = join(root, 'nodes.json');
  if (!existsSync(nodesFile)) {
    throw new Error(`${root} has no nodes.json`);
  }
  const parsed: unknown = JSON.parse(readFileSync(nodesFile, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${nodesFile} is not an array`);

  const metaFile = join(root, 'meta.json');
  const meta = existsSync(metaFile)
    ? (JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>)
    : {};
  const n8nVersion = typeof meta['n8nVersion'] === 'string' ? meta['n8nVersion'] : undefined;
  if (n8nVersion === undefined) {
    throw new Error(`${metaFile} must name the n8n version it describes, as "n8nVersion"`);
  }

  return {
    n8nVersion,
    libraryVersion: typeof meta['libraryVersion'] === 'string' ? meta['libraryVersion'] : n8nVersion,
    // Trimmed, but never filtered: the allowlist exists to shrink n8n's own
    // 500-entry dump, and applying it here would discard the custom nodes this
    // flag exists to load.
    nodes: harvest(parsed, { all: true }),
    source: root,
  };
}

/**
 * What is available, and what a run would pick.
 *
 * This exists to answer "why did it say the match was approximate?" without
 * anyone reading the code. It touches nothing.
 */
function listSources(io: Io): number {
  const root = join(cacheRoot(io.env ?? {}), 'node-types');
  const extracted = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];

  const pinned = readConfig(io).n8nVersion;
  io.out(
    pinned === undefined
      ? 'pinned version: none (set n8nVersion in .workflow-tester/config.yaml)'
      : `pinned version: ${pinned} (.workflow-tester/config.yaml)`,
  );
  io.out('');
  io.out(`bundled:   ${SUPPORTED_N8N_VERSION} (inside workflow-tester, always available)`);
  io.out(
    extracted.length === 0
      ? 'extracted: none — `workflow-tester node-types --version <v>` to add one'
      : `extracted: ${extracted.join(', ')}`,
  );
  io.out('');

  const wanted = pinned ?? SUPPORTED_N8N_VERSION;
  const exact = extracted.includes(wanted) || wanted === SUPPORTED_N8N_VERSION;
  const chosen = extracted.includes(wanted)
    ? `extracted ${wanted}`
    : `bundled ${SUPPORTED_N8N_VERSION}`;
  io.out(`a run would use: ${chosen}${exact ? '' : ` — not an exact match for ${wanted}`}`);
  if (!exact) {
    io.out('  a missing required parameter is reported as a warning, not a failure');
  }
  return EXIT.ok;
}
