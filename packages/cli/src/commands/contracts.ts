import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { materialize, readContract, ContractError } from 'payload-contract-contracts';
import { loadCatalog, UnknownVendorError } from 'payload-contract-vendors';
import { parseDocument } from 'yaml';
import { EXIT, parseArgs, type Io } from '../io.js';

const WEBHOOK_TYPES = new Set([
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.formTrigger',
  '@n8n/n8n-nodes-langchain.chatTrigger',
]);

interface WorkflowFile {
  nodes?: Array<{ name?: string; type?: string }>;
}

/** Where materialised shapes live for a repo. */
const contractsDir = (repo: string): string => join(repo, '.payload-contract', 'contracts');

/** The contract that belongs beside a workflow file. */
export const contractPathFor = (workflow: string): string =>
  join(dirname(workflow), `${basename(workflow, extname(workflow))}.contract.yaml`);

/** Pick the trigger node, or explain why it cannot be picked. */
function inferTrigger(workflow: WorkflowFile, explicit?: string): { trigger: string } | { error: string } {
  if (explicit !== undefined) {
    const known = (workflow.nodes ?? []).some((n) => n.name === explicit);
    return known ? { trigger: explicit } : { error: `no node named "${explicit}" in this workflow` };
  }
  const triggers = (workflow.nodes ?? [])
    .filter((n) => n.type !== undefined && WEBHOOK_TYPES.has(n.type))
    .map((n) => n.name ?? '');

  if (triggers.length === 1) return { trigger: triggers[0] as string };
  if (triggers.length === 0) return { error: 'no webhook trigger in this workflow; name one with --trigger' };
  return {
    error: `this workflow has ${triggers.length} webhook triggers (${triggers.join(', ')}); pick one with --trigger`,
  };
}

async function addContract(argv: string[], io: Io): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const workflowArg = positional[0];
  if (workflowArg === undefined) {
    io.err('usage: payload-contract contracts add <workflow.json> --vendor <v> --events <a,b> [--trigger <name>]');
    return EXIT.usage;
  }

  const workflowFile = join(io.cwd, relative(io.cwd, workflowArg));
  if (!existsSync(workflowFile)) {
    io.err(`no such workflow file: ${workflowArg}`);
    return EXIT.usage;
  }

  const vendor = flags.vendor;
  const events = flags.events;
  if (typeof vendor !== 'string' || typeof events !== 'string') {
    io.err('both --vendor and --events are required');
    return EXIT.usage;
  }

  const workflow = JSON.parse(await readFile(workflowFile, 'utf8')) as WorkflowFile;
  const inferred = inferTrigger(workflow, typeof flags.trigger === 'string' ? flags.trigger : undefined);
  if ('error' in inferred) {
    io.err(inferred.error);
    return EXIT.usage;
  }

  const eventList = events.split(',').map((e) => e.trim()).filter((e) => e.length > 0);
  const contractFile = contractPathFor(workflowFile);

  let text: string;
  let replaced: string | undefined;
  if (!existsSync(contractFile)) {
    // Written as text rather than serialised from an object so the file a user
    // opens first is commented and ordered the way the docs describe it.
    text = [
      'version: 1',
      `trigger: ${inferred.trigger}`,
      'source:',
      '  kind: vendor',
      `  vendor: ${vendor}`,
      '  events:',
      ...eventList.map((e) => `    - ${e}`),
      '# The only hand-edited section: paths to keep, prune, or restrict to.',
      '# overrides:',
      '#   required: []',
      '#   never: []',
      '#   only: []',
      '',
    ].join('\n');
  } else {
    // An existing contract is kept — overrides and comments included — but
    // the flags given now win over what it says: a retry after a typo must
    // not be beaten by the file the typo produced.
    text = await readFile(contractFile, 'utf8');
    const doc = parseDocument(text);
    const current = doc.toJS() as { source?: { vendor?: unknown; events?: unknown } } | null;
    const currentVendor = current?.source?.vendor;
    const currentEvents = Array.isArray(current?.source?.events) ? (current.source.events as unknown[]) : [];
    const same =
      currentVendor === vendor &&
      currentEvents.length === eventList.length &&
      currentEvents.every((event, index) => event === eventList[index]);
    if (!same) {
      doc.setIn(['source', 'vendor'], vendor);
      doc.setIn(['source', 'events'], eventList);
      replaced = `${String(currentVendor)}: ${currentEvents.map(String).join(', ')}`;
      text = doc.toString();
    }
  }

  // Validated before anything lands at the real path: the contract is
  // materialised from a temporary copy and renamed into place only once that
  // succeeded. A failed add leaves no file behind, and a failed update leaves
  // the old one untouched.
  const staging = `${contractFile}.tmp`;
  await writeFile(staging, text);
  const code = await materializeContract(staging, io, contractFile);
  if (code !== EXIT.ok) {
    await rm(staging, { force: true });
    return code;
  }
  await rename(staging, contractFile);
  if (replaced !== undefined) io.out(`  (source replaced — was ${replaced})`);
  return code;
}

/**
 * Materialise one contract, reporting what it produced. `shownAs` is the path
 * to report when the file being materialised is a staging copy.
 */
async function materializeContract(contractFile: string, io: Io, shownAs = contractFile): Promise<number> {
  try {
    const { contract, dir } = await readContract(contractFile);
    const catalog = loadCatalog(contract.source.vendor, contract.source.specVersion);

    // `materialize` creates the output directory itself, after validating the
    // events, so a rejected contract leaves no empty directory behind.
    const result = await materialize(contract, catalog, {
      outDir: contractsDir(io.cwd),
      contractDir: dir,
      contractFile,
    });

    io.out(`${relative(io.cwd, shownAs)}`);
    io.out(`  vendor  ${contract.source.vendor} @ ${result.specVersion}`);
    io.out(`  events  ${result.events.join(', ')}`);
    io.out(`  shape   ${result.shape?.schema ?? ''}`);
    for (const warning of result.warnings) io.out(`  warn    ${warning}`);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof ContractError || error instanceof UnknownVendorError) {
      io.err(error.message);
      return EXIT.usage;
    }
    io.err(error instanceof Error ? error.message : String(error));
    return EXIT.usage;
  }
}

/** Every contract file in the repo, sorted for deterministic output. */
export async function findContracts(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.contract.yaml')) found.push(full);
    }
  };
  await walk(root);
  return found.sort();
}

async function updateContracts(argv: string[], io: Io): Promise<number> {
  const { positional, flags } = parseArgs(argv);

  if (flags.fetch === true) {
    // The one networked path, and only ever on an explicit flag.
    const { ingestAll } = await import('payload-contract-vendors/ingest');
    io.out('fetching vendor specs…');
    await ingestAll(typeof flags.vendor === 'string' ? flags.vendor : undefined, { refetch: true });
  }

  const targets =
    positional.length > 0
      ? positional.map((p) => contractPathFor(join(io.cwd, relative(io.cwd, p))))
      : await findContracts(io.cwd);

  if (targets.length === 0) {
    io.out('no contracts found');
    return EXIT.ok;
  }

  // EXIT is `as const`, so this needs widening to hold a worse code later.
  let worst: number = EXIT.ok;
  for (const contract of targets) {
    const code = await materializeContract(contract, io);
    if (code > worst) worst = code;
  }
  return worst;
}

export async function contractsCommand(argv: string[], io: Io): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === 'add') return await addContract(rest, io);
  if (verb === 'update') return await updateContracts(rest, io);
  io.err(`payload-contract contracts: unknown subcommand "${String(verb)}" (expected add or update)`);
  return EXIT.usage;
}
