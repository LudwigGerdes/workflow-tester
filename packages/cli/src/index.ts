import { captureCommand } from './commands/capture.js';
import { contractsCommand } from './commands/contracts.js';
import { genCommand } from './commands/gen.js';
import { nodeTypesCommand } from './commands/node-types.js';
import { promoteCommand } from './commands/promote.js';
import { explainCommand, initCommand, runCommand, schemaCommand } from './commands/run.js';
import { vendorsCommand } from './commands/vendors.js';
import { syncCommand } from './commands/sync.js';
import { SuiteError } from 'workflow-tester-runner';
import { EXIT, type Io } from './io.js';

export { EXIT, type Io } from './io.js';

import { VERSION } from './version.js';

/**
 * One usage block per command. `workflow-tester --help` prints them all;
 * `workflow-tester <command> --help` prints one.
 */
const USAGE: Record<string, string> = {
  contracts: `  workflow-tester contracts add <workflow.json> --vendor <v> --events <a,b> [--trigger <name>]
      Write a contract beside the workflow and materialise its shape files.
      The events are checked against the vendor catalog before anything is
      written; on an existing contract a later --events replaces the old.

  workflow-tester contracts update [<workflow.json>...] [--all] [--fetch] [--vendor <v>]
      Re-materialise from the vendored catalogs. --fetch re-downloads the
      vendor spec first, and is the only command that touches the network.`,

  gen: `  workflow-tester gen [<workflow.json>...] [--max N] [--check]
      Generate the variant cases for each contract into .workflow-tester/cases.
      --check writes nothing and exits 1 when regeneration would change
      something (use it in pre-commit and CI).`,

  run: `  workflow-tester run [<workflow.json>] [--only generated|tests] [--format <f>]
                       [--fail-on warn] [--concurrency N]
      Run every case through the tier-1 engine. --format is stylish
      (default), json, junit, sarif or github-actions.`,

  explain: `  workflow-tester explain <caseId>
      Print a case as a test file, plus what the last run made of it.`,

  schema: `  workflow-tester schema
      Print the JSON Schema for a test file.`,

  init: `  workflow-tester init [--n8n-version <v>] [--no-ask]
      Scaffold .workflow-tester with a commented example test.`,

  promote: `  workflow-tester promote <caseId> [--name <file>]
      Copy a generated case into a hand-written test, with a then: skeleton,
      and keep the original from being retired.`,

  capture: `  workflow-tester capture <workflow.json> --execution <file.json> | --instance <url>
                           [--workflow <id>] [--awaiting] [--update]
      Record what each node produced, as shape only, into the workflow's
      sidecar. Values never reach disk. --awaiting marks a workflow that is
      active but has not run yet. --instance takes the newest execution from a
      running n8n instead of a file, with the workflow id from the file or
      --workflow.`,

  sync: `  workflow-tester sync [--instance <url>] [--interval 30s] [--once]
      Compare every capture in this repo against the instance. In dev mode a
      newer execution is recorded; otherwise it is reported and the pass exits
      1. The api key comes from N8N_API_KEY.`,

  vendors: `  workflow-tester vendors list
      Vendors, coverage, pinned spec version and event counts.

  workflow-tester vendors events <vendor>
      The event names \`contracts add --events\` accepts for that vendor, one per line.

  workflow-tester vendors audit
      Print the per-vendor coverage audit.`,

  'node-types': `  workflow-tester node-types --version <n8n version> | --instance <url> | --from <dir>
      Extract the node descriptions workflow-tester reads, for one n8n version, into
      ~/.workflow-tester/node-types/. --version downloads them from the npm registry;
      --instance asks a running n8n which version it is first, needing no
      credential; --from reads a directory you wrote yourself, which is how
      custom nodes get described and touches no network. Without any of them,
      workflow-tester uses the version bundled inside it.

  workflow-tester node-types --list
      What is available and which one a run would choose, with whether that
      match is exact. Touches nothing.`,
};

const HELP = `workflow-tester — contract-driven tests for n8n workflows

${Object.values(USAGE).join('\n\n')}

  workflow-tester <command> --help     Usage for one command.
  workflow-tester --version            Print the version.

Exit codes: 0 clean, 1 findings, 2 usage or configuration error.
`;

/** Entry point, parameterised over its IO so it can be driven from tests. */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    // A malformed test file is a configuration mistake, not a crash. Letting it
    // escape prints a stack trace over the actual message, which reads as the
    // tool breaking rather than the file being wrong.
    if (error instanceof SuiteError) {
      io.err(`workflow-tester: ${error.message}`);
      return EXIT.usage;
    }
    throw error;
  }
}

const wantsHelp = (args: string[]): boolean => args.includes('--help') || args.includes('-h');

async function dispatch(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;

  if (command === '--version' || command === '-v') {
    io.out(`workflow-tester ${VERSION}`);
    return EXIT.ok;
  }
  if (command === undefined || command === '--help' || command === '-h') {
    io.out(HELP);
    return EXIT.ok;
  }
  if (command === 'help') {
    const [topic] = rest;
    if (topic === undefined) {
      io.out(HELP);
      return EXIT.ok;
    }
    const usage = USAGE[topic];
    if (usage === undefined) {
      io.err(`workflow-tester: unknown command "${topic}"\n\n${HELP}`);
      return EXIT.usage;
    }
    io.out(usage);
    return EXIT.ok;
  }

  // Routed before the command sees its arguments, so `run --help` prints
  // usage rather than running the suite and `init --help` scaffolds nothing.
  const usage = USAGE[command];
  if (usage !== undefined && wantsHelp(rest)) {
    io.out(usage);
    return EXIT.ok;
  }

  if (command === 'capture') return await captureCommand(rest, io);
  if (command === 'contracts') return await contractsCommand(rest, io);
  if (command === 'gen') return await genCommand(rest, io);
  if (command === 'run') return await runCommand(rest, io);
  if (command === 'explain') return await explainCommand(rest, io);
  if (command === 'schema') return schemaCommand(io);
  if (command === 'init') return await initCommand(io, rest);
  if (command === 'promote') return await promoteCommand(rest, io);
  if (command === 'sync') return await syncCommand(rest, io);
  if (command === 'vendors') return vendorsCommand(rest, io);
  if (command === 'node-types') return await nodeTypesCommand(rest, io);

  io.err(`workflow-tester: unknown command "${command}"\n\n${HELP}`);
  return EXIT.usage;
}
