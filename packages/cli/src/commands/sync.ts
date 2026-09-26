import { readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { readCapture, sidecarsUnder } from 'workflow-tester-contracts';
import type { InstanceClient } from 'workflow-tester-instance';
// `writeCapture` lives beside the capture command rather than in contracts,
// which is asymmetric with `readCapture` but not this task's to change.
import { nodesFromExecution, provenanceOf, writeCapture } from './capture.js';
import { createClient } from 'workflow-tester-instance';
import { modeOf } from '../mode.js';
import { instanceConfig } from '../instance-config.js';
import { EXIT, parseArgs, type Io } from '../io.js';

export interface SyncResult {
  /** Workflows with a capture that were compared against the instance. */
  checked: number;
  /** Workflows whose capture was replaced, repo-relative. */
  captured: string[];
  /** Workflows the instance has run more recently than the capture records. */
  behind: string[];
}

/**
 * One pass over every captured workflow.
 *
 * The listing is cheap and carries no node data, so a pass costs one small
 * request per workflow and fetches a full execution only when it has decided to
 * record one. `CaptureRecord.executionId` is what makes "newer" answerable
 * without inventing any new state.
 */
export async function syncOnce(
  io: Io,
  client: InstanceClient,
  /** The instance's base URL, recorded in a capture's provenance. Never the key. */
  instance?: string,
): Promise<SyncResult> {
  const dev = modeOf(io) === 'dev';
  const result: SyncResult = { checked: 0, captured: [], behind: [] };

  for (const sidecar of sidecarsUnder(io.cwd)) {
    const workflowFile = join(dirname(sidecar), `${basename(sidecar, '.contract.yaml')}.json`);
    const capture = readCapture(workflowFile);
    if (capture?.executionId === undefined) continue;
    result.checked += 1;

    const local = JSON.parse(readFileSync(workflowFile, 'utf8')) as { id?: unknown };
    if (typeof local.id !== 'string') continue;

    let newest;
    try {
      const runs = await client.listExecutions(local.id, 10);
      [newest] = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    } catch (error) {
      // One unreachable workflow does not end the pass: the others are still
      // worth checking, and a sync that stopped at the first 404 would be
      // useless on a repo whose workflows span two instances.
      io.err(
        `workflow-tester: ${relative(io.cwd, workflowFile)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    if (newest === undefined || newest.id === capture.executionId) continue;

    const shown = relative(io.cwd, workflowFile);
    if (!dev) {
      io.out(
        `${shown}: instance has a newer execution (${newest.id}); capture records ${capture.executionId}`,
      );
      result.behind.push(shown);
      continue;
    }

    const execution = await client.getExecution(newest.id);
    const nodes = nodesFromExecution(execution);
    if (Object.keys(nodes).length === 0) continue;
    writeCapture(sidecar, {
      capturedAt: new Date().toISOString(),
      executionId: newest.id,
      ...provenanceOf(execution, { kind: 'instance', ...(instance === undefined ? {} : { instance }) }),
      nodes,
    });
    io.out(`${shown}: captured execution ${newest.id}`);
    result.captured.push(shown);
  }

  return result;
}

/**
 * `30s`, `2m`. A bare number is refused rather than assumed: a poll that meant
 * to be thirty seconds and turned out to be thirty milliseconds is a denial of
 * service against the instance you were trying to be helpful about.
 */
export function parseInterval(text: string): number | undefined {
  const match = /^(\d+)(s|m)$/.exec(text.trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return match[2] === 'm' ? amount * 60_000 : amount * 1_000;
}

const HELP = `workflow-tester sync [--instance <url>] [--interval 30s] [--once]

Watches an instance and keeps the captures in this repo in step with it.

  --instance <url>  where n8n is; defaults to N8N_API_URL
  --interval <30s>  how often to poll; 30s by default
  --once            make one pass and stop

The api key comes from N8N_API_KEY. In dev mode a newer execution is captured;
otherwise it is reported and the pass exits 1, which is what makes this usable
as a CI check.`;

export async function syncCommand(
  argv: string[],
  io: Io,
  deps?: { client?: InstanceClient },
): Promise<number> {
  const { flags } = parseArgs(argv);
  if (flags['help'] === true) {
    io.out(HELP);
    return EXIT.ok;
  }

  const intervalFlag = flags['interval'];
  const interval =
    intervalFlag === undefined
      ? 30_000
      : typeof intervalFlag === 'string'
        ? parseInterval(intervalFlag)
        : undefined;
  if (interval === undefined) {
    io.err('workflow-tester: --interval takes a value like 30s or 2m');
    return EXIT.usage;
  }

  const config = instanceConfig(io, flags);
  if ('error' in config) {
    io.err(config.error);
    return EXIT.usage;
  }
  const client = deps?.client ?? createClient(config);

  const pass = async (): Promise<number> => {
    const result = await syncOnce(io, client, config.url);
    return result.behind.length > 0 ? EXIT.findings : EXIT.ok;
  };

  if (flags['once'] === true) return await pass();

  // The loop is deliberately the thinnest thing here: everything worth testing
  // lives in one pass, and a test that had to wait on a timer would be a test
  // about timers.
  io.out(`workflow-tester: watching ${config.url} every ${interval / 1000}s — ctrl-c to stop`);
  for (;;) {
    await pass();
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
