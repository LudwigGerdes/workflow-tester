import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  diffShape,
  readCapture,
  shapeOfItems,
  sidecarFor,
  type CaptureRecord,
  type CapturedNode,
  type ShapeChange,
} from 'workflow-test-contracts';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { createClient, type InstanceClient } from 'workflow-test-instance';
import { EXIT, parseArgs, type Io } from '../io.js';
import { instanceConfig } from '../instance-config.js';
import { modeOf } from '../mode.js';

/**
 * Turning a real execution into a test.
 *
 * Nobody who built a workflow by dragging boxes in a browser is going to open a
 * terminal and hand-write test cases for it. If writing a test is a separate
 * task it does not get done, and the suite is stale within a month. So the test
 * has to fall out of work that already happened: you ran the workflow, and the
 * run is the test.
 *
 * Only shape is written. See `workflow-test-contracts`'s shape module for why.
 */


interface RunData {
  [node: string]: Array<{ data?: { main?: Array<Array<{ json?: unknown }>> } }>;
}

/**
 * Pull per-node output out of an n8n execution export.
 *
 * n8n nests this as node → run → output index → items, and a node can run more
 * than once (inside a loop). Every run of a node is merged, so a field that
 * only appears on the second pass is still recorded.
 */
export function nodesFromExecution(execution: unknown): Record<string, CapturedNode> {
  const exec = execution as {
    data?: { resultData?: { runData?: RunData } };
    resultData?: { runData?: RunData };
    workflowData?: { nodes?: Array<{ name: string; id?: string }> };
    workflow?: { nodes?: Array<{ name: string; id?: string }> };
  };

  const runData = exec.data?.resultData?.runData ?? exec.resultData?.runData ?? {};
  const declared = exec.workflowData?.nodes ?? exec.workflow?.nodes ?? [];
  const idOf = new Map(declared.map((n) => [n.name, n.id]));

  const captured: Record<string, CapturedNode> = {};
  for (const [name, runs] of Object.entries(runData)) {
    const items = runs.flatMap((run) => (run.data?.main ?? []).flat()).filter((i) => i !== null);
    if (items.length === 0) continue;
    const id = idOf.get(name);
    captured[name] = {
      ...(id !== undefined ? { id } : {}),
      shape: shapeOfItems(items),
      items: items.length,
    };
  }
  return captured;
}


/** Merge a capture into the workflow's sidecar, leaving the rest untouched. */
export function writeCapture(sidecar: string, record: CaptureRecord): void {
  const existing = existsSync(sidecar)
    ? ((parseYaml(readFileSync(sidecar, 'utf8')) ?? {}) as Record<string, unknown>)
    : { version: 1 };
  writeFileSync(sidecar, stringifyYaml({ ...existing, capture: record }), 'utf8');
}

/**
 * What changed between the recorded capture and a fresh one.
 *
 * A node that stopped producing a field is the dangerous case: whatever reads
 * it downstream now resolves to undefined, and n8n swallows that silently. It
 * is still reported rather than failed — a suite that fails on every legitimate
 * edit gets regenerated without being read, and then it is catching nothing.
 */
export function driftBetween(
  before: Record<string, CapturedNode>,
  after: Record<string, CapturedNode>,
): Array<{ node: string; changes: ShapeChange[] }> {
  const drift: Array<{ node: string; changes: ShapeChange[] }> = [];

  for (const [name, recorded] of Object.entries(before)) {
    const fresh = after[name] ?? findByRenamedId(after, recorded.id);
    if (fresh === undefined) {
      drift.push({
        node: name,
        changes: [{ path: '(node)', kind: 'removed', detail: 'no longer produces output' }],
      });
      continue;
    }
    const changes = diffShape(recorded.shape, fresh.shape);
    if (changes.length > 0) drift.push({ node: name, changes });
  }
  return drift;
}

/**
 * A renamed node keeps its id. Without this a rename reads as a deletion plus
 * an addition, and every rename would raise a false alarm on a feature whose
 * value depends on not crying wolf.
 */
function findByRenamedId(
  after: Record<string, CapturedNode>,
  id: string | undefined,
): CapturedNode | undefined {
  if (id === undefined) return undefined;
  return Object.values(after).find((node) => node.id === id);
}

const HELP = `workflow-test capture <workflow.json> --execution <file.json>
       workflow-test capture <workflow.json> --awaiting

Record what each node produced, as shape only, into the workflow's sidecar.

  --execution <file>  an n8n execution export to read
  --awaiting          mark the workflow as having no execution yet
  --update            overwrite an existing capture (drift is reported first)
`;

export async function captureCommand(
  argv: string[],
  io: Io,
  deps?: { client?: InstanceClient },
): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const target = positional[0];

  if (target === undefined || flags['help'] === true) {
    io.out(HELP);
    return target === undefined ? EXIT.usage : EXIT.ok;
  }

  const workflowFile = resolve(io.cwd, target);
  if (!existsSync(workflowFile)) {
    io.err(`workflow-test: no such workflow ${target}`);
    return EXIT.usage;
  }
  const sidecar = sidecarFor(workflowFile);

  // An activated workflow has no execution at the moment it is activated; the
  // first arrives shortly after. Recording that is better than failing, and far
  // better than writing an empty capture that would read as "nothing produced".
  if (flags['awaiting'] === true) {
    writeCapture(sidecar, { capturedAt: new Date().toISOString(), awaitingFirstExecution: true });
    io.out(`${basename(workflowFile)}: awaiting first execution`);
    return EXIT.ok;
  }

  let execution: unknown;
  /** What to call the execution's origin in a message. */
  let sourceLabel: string;

  const wanted = flags['instance'];
  if (wanted !== undefined && flags['execution'] !== undefined) {
    io.err('workflow-test: pass --instance or --execution, not both');
    return EXIT.usage;
  }

  if (wanted !== undefined) {
    const config = instanceConfig(io, flags);
    if ('error' in config) {
      io.err(config.error);
      return EXIT.usage;
    }
    const client = deps?.client ?? createClient(config);

    // The workflow's own id is the right default; --workflow covers a local
    // file that came from somewhere else.
    const local = JSON.parse(readFileSync(workflowFile, 'utf8')) as { id?: unknown };
    const flagged = flags['workflow'];
    const workflowId = typeof flagged === 'string' ? flagged : local.id;
    if (typeof workflowId !== 'string') {
      io.err('workflow-test: no workflow id in the file — pass --workflow <id>');
      return EXIT.usage;
    }

    try {
      const runs = await client.listExecutions(workflowId, 10);
      // The API returns newest first; sorting says so rather than assuming it,
      // because a capture that recorded the wrong run would be silent.
      const [newest] = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      if (newest === undefined) {
        io.out(`${basename(workflowFile)}: no execution on the instance yet`);
        return EXIT.ok;
      }
      execution = await client.getExecution(newest.id);
      sourceLabel = `execution ${newest.id}`;
    } catch (error) {
      io.err(`workflow-test: ${error instanceof Error ? error.message : String(error)}`);
      return EXIT.usage;
    }
  } else {
    const source = flags['execution'];
    if (typeof source !== 'string') {
      io.err('workflow-test: capture needs --execution <file.json>, --instance <url>, or --awaiting');
      return EXIT.usage;
    }

    const file = resolve(io.cwd, source);
    if (!existsSync(file)) {
      io.err(`workflow-test: no such execution ${source}`);
      return EXIT.usage;
    }

    try {
      execution = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      io.err(`workflow-test: ${source} is not valid JSON: ${(error as Error).message}`);
      return EXIT.usage;
    }
    sourceLabel = source;
  }

  const nodes = nodesFromExecution(execution);
  if (Object.keys(nodes).length === 0) {
    io.err(`workflow-test: ${sourceLabel} records no node output`);
    return EXIT.usage;
  }

  // An existing capture is never silently replaced. Report what moved, and
  // require --update to accept it, so a fixture changes only when meant to.
  const previous = readCapture(workflowFile);
  if (previous?.nodes !== undefined) {
    const drift = driftBetween(previous.nodes, nodes);
    if (drift.length > 0) {
      io.out(`${basename(workflowFile)}: ${drift.length} node(s) changed shape`);
      for (const { node, changes } of drift) {
        io.out(`  ${node}`);
        for (const change of changes) io.out(`    ${change.kind}  ${change.path}  ${change.detail}`);
      }
    } else {
      io.out(`${basename(workflowFile)}: no shape change`);
    }
    // An explicit --update always accepts. Otherwise the mode decides: dev
    // accepts drift, test reports it and leaves the record alone. Either way
    // the drift was printed above — accepting it is not hiding it.
    if (flags['update'] !== true && modeOf(io) !== 'dev') {
      if (drift.length > 0) io.out('  re-run with --update to accept');
      return EXIT.ok;
    }
  }

  const executionId = (execution as { id?: string | number }).id;
  writeCapture(sidecar, {
    capturedAt: new Date().toISOString(),
    ...(executionId !== undefined ? { executionId: String(executionId) } : {}),
    nodes,
  });

  const count = Object.keys(nodes).length;
  io.out(`${basename(workflowFile)}: captured ${count} node${count === 1 ? '' : 's'} (shape only)`);
  for (const [name, node] of Object.entries(nodes)) {
    io.out(`  ${name}  ${node.items} item${node.items === 1 ? '' : 's'}`);
  }
  return EXIT.ok;
}


export { readCapture, sidecarFor };
