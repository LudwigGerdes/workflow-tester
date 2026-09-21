import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { runInSandbox, walk, loadNodeTypes, type EngineInput, type EngineResult } from 'workflow-test-engine';
import { wrapWebhook, substitutesFor, readCapture, outcomesFor } from 'workflow-test-contracts';
import { loadSuites } from './load.js';
import { evaluateThen, type Outcome } from './oracle.js';
import { applyStructure, checkStructure } from './structure-check.js';
import { caseFromCapture } from './capture-case.js';
import { applyClassification, classifyTerminus } from './classify.js';
import { checkTerminalShape } from './terminal-shape.js';
import { terminiOf } from './termini.js';
import { mapPooled } from './pool.js';
import type { Suite, SuiteCase } from './types.js';

export interface RunOptions {
  dir: string;
  /** Narrow to generated cases or hand-written tests. */
  only?: 'generated' | 'tests';
  /** Only suites whose workflow file name matches. */
  workflow?: string;
  concurrency?: number;
  /** Per-case wall clock budget. */
  timeoutMs?: number;
  /**
   * Run cases in-process instead of in a worker. Faster, but without the
   * timeout and memory guarantees; the CLI always sandboxes.
   */
  sandbox?: boolean;
  /**
   * The n8n release these workflows run on, from `.workflow-test/config.yaml`.
   * Absent, the bundled descriptions are used and the report says so.
   */
  n8nVersion?: string;
}

export interface RunSummary {
  pass: number;
  fail: number;
  warn: number;
  needsExecution: number;
  durationMs: number;
}

export interface RunReport {
  outcomes: Outcome[];
  summary: RunSummary;
  /** Suites that produced at least one case. */
  suites: number;
  /**
   * Which node descriptions the run used, and whether they were the version
   * that was asked for. An inexact match downgrades a missing required
   * parameter to a warning, which is invisible unless the report says so.
   */
  nodeTypes?: { version: string; exact: boolean; note?: string };
}

const TRIGGER_KINDS: Record<string, string[]> = {
  webhook: ['n8n-nodes-base.webhook'],
  form: ['n8n-nodes-base.formTrigger'],
  chat: ['@n8n/n8n-nodes-langchain.chatTrigger'],
};

interface WorkflowNode {
  name: string;
  type: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Resolve what a case's `trigger` refers to: a node by name, a kind such as
 * `webhook`, or — when it says nothing — the workflow's only trigger.
 */
function resolveTrigger(nodes: WorkflowNode[], requested: string | undefined): string | undefined {
  if (requested !== undefined) {
    const named = nodes.find((node) => node.name === requested);
    if (named !== undefined) return named.name;

    const kinds = TRIGGER_KINDS[requested];
    if (kinds !== undefined) {
      const matching = nodes.filter((node) => kinds.includes(node.type));
      if (matching.length === 1) return matching[0]?.name;
    }
  }
  const triggers = nodes.filter((node) =>
    Object.values(TRIGGER_KINDS).flat().includes(node.type),
  );
  return triggers.length === 1 ? triggers[0]?.name : undefined;
}

/**
 * A payload becomes an engine input as-is when it is already shaped like what a
 * webhook delivers. Generated cases are wrapped at generation time; a
 * hand-written payload is usually just the body, so it is wrapped here — a test
 * an LLM wrote against `$json.body.x` should not fail on plumbing.
 */
function asItemJson(payload: unknown, trigger: string | undefined, nodes: WorkflowNode[]): unknown {
  // A `body` is the tell that the payload is already an envelope. Requiring
  // `headers` too would double-wrap the common hand-written shape — the case
  // would then read `$json.body.body.…` and fail for a reason that has nothing
  // to do with the workflow.
  if (isRecord(payload) && 'body' in payload) return payload;
  const node = nodes.find((entry) => entry.name === trigger);
  const isWebhook = node !== undefined && TRIGGER_KINDS.webhook?.includes(node.type) === true;
  if (!isWebhook) return payload;
  return wrapWebhook(payload, { vendor: 'unknown' });
}

/** Run every case in a repo through the tier-1 engine. */
export async function runTier1(options: RunOptions): Promise<RunReport> {
  const started = performance.now();
  const { generated, tests, captured } = await loadSuites(options.dir);

  // A workflow already covered by real cases does not also need one derived
  // from its capture — the cases are the stronger evidence.
  const covered = new Set(
    [...generated, ...tests].map((suite) => resolve(dirname(suite.file), suite.workflow)),
  );
  const uncovered = captured.filter(
    (suite) => !covered.has(resolve(dirname(suite.file), suite.workflow)),
  );

  const chosen: Suite[] =
    options.only === 'generated'
      ? generated
      : options.only === 'tests'
        ? tests
        : [...generated, ...tests, ...uncovered];

  const suites = chosen.filter(
    (suite) => options.workflow === undefined || suite.workflow.includes(options.workflow),
  );

  interface Job {
    suite: Suite;
    /** Repo-relative path, for reports. */
    shownAs: string;
    /** Absolute path, for reading the capture and its declarations. */
    workflowFile: string;
    entry: SuiteCase;
    input: EngineInput;
  }

  const jobs: Job[] = [];
  const outcomes: Outcome[] = [];

  for (const suite of suites) {
    const workflowFile = resolve(dirname(suite.file), suite.workflow);
    if (!existsSync(workflowFile)) {
      for (const entry of suite.cases) {
        outcomes.push({
          caseId: entry.id,
          workflow: suite.workflow,
          status: 'fail',
          tier: 1,
          message: `workflow not found: ${suite.workflow} (from ${suite.file})`,
          assertions: [],
        });
      }
      continue;
    }

    const substitutes = substitutesFor(workflowFile);
    const workflow = JSON.parse(await readFile(workflowFile, 'utf8')) as {
      nodes?: WorkflowNode[];
    };
    const nodes = workflow.nodes ?? [];

    // Suites reference their workflow relative to themselves, and a generated
    // suite sits four directories deep — so reporting that path verbatim gives
    // `../../../../workflows/x.json`. Reports name it relative to the repo,
    // which is also the URI form SARIF wants.
    const shownAs = relative(options.dir, workflowFile);

    for (const entry of suite.cases) {
      // A trigger is named directly (`trigger: webhook`) or given as an object
      // carrying its own payload (`trigger: { node: Webhook, payload: … }`).
      const declared = entry.when.trigger;
      const named = typeof declared === 'string' ? declared : declared?.node;
      const payload =
        entry.when.payload ??
        (typeof declared === 'object' && declared !== null ? declared.payload : undefined);

      const trigger = resolveTrigger(nodes, named);
      if (trigger === undefined) {
        outcomes.push({
          caseId: entry.id,
          workflow: shownAs,
          status: 'fail',
          tier: 1,
          message:
            named === undefined
              ? 'this workflow has no single trigger; name one in `when.trigger`'
              : `no trigger matching "${named}" in ${suite.workflow}`,
          assertions: [],
        });
        continue;
      }

      jobs.push({
        suite,
        shownAs,
        workflowFile,
        entry,
        input: {
          workflow: workflow as EngineInput['workflow'],
          trigger,
          payload: asItemJson(payload, trigger, nodes),
          // A recorded capture lets the walk carry on past a node it cannot
          // run, so one HTTP call in the middle costs that node rather than
          // everything after it. Absent, the walk stops at the boundary as
          // before.
          ...(Object.keys(substitutes).length > 0 ? { substitutes } : {}),
          // The worker loads its own descriptions, so it must be told the
          // same version the host just reported — otherwise a case would
          // run against descriptions the report does not name.
          ...(options.n8nVersion === undefined ? {} : { n8nVersion: options.n8nVersion }),
        },
      });
    }

    // A workflow with a capture and no cases used to report a clean bill of
    // health over a workflow nothing had looked at. The capture describes what
    // the trigger receives, so it can stand up one case by itself.
    //
    // `trigger` inside the loop above is per-case, resolved from that case's
    // `when.trigger`. This has no case, so it resolves the workflow's own.
    if (suite.cases.length === 0) {
      const derivedTrigger = resolveTrigger(nodes, undefined);
      const derived =
        derivedTrigger === undefined
          ? undefined
          : caseFromCapture(readCapture(workflowFile), derivedTrigger);
      if (derived !== undefined && derivedTrigger !== undefined) {
        jobs.push({
          suite,
          shownAs,
          workflowFile,
          entry: { id: derived.id, title: derived.title, when: {} },
          input: {
            workflow: workflow as EngineInput['workflow'],
            trigger: derivedTrigger,
            payload: asItemJson(derived.payload, derivedTrigger, nodes),
            ...(Object.keys(substitutes).length > 0 ? { substitutes } : {}),
            // The worker loads its own descriptions, so it must be told the
            // same version the host just reported — otherwise a case would
            // run against descriptions the report does not name.
            ...(options.n8nVersion === undefined ? {} : { n8nVersion: options.n8nVersion }),
          },
        });
      }
    }
  }

  const useSandbox = options.sandbox !== false;
  // Loaded even when the cases run in the worker: the report names the version
  // the descriptions came from, and the bundle caches, so the second load in
  // the sandbox costs nothing.
  const nodeTypes = await loadNodeTypes(options.n8nVersion);

  const results = await mapPooled(
    jobs,
    options.concurrency ?? availableParallelism(),
    async (job) => {
      const result = useSandbox
        ? await runInSandbox(job.input, { timeoutMs: options.timeoutMs })
        : walk(job.input, nodeTypes);
      return { job, result };
    },
  );

  for (const { job, result } of results) {
    if (result.status === 'timeout' || result.status === 'crashed') {
      outcomes.push({
        caseId: job.entry.id,
        status: 'fail',
        tier: 1,
        message: `${result.status}: ${(result as { message: string }).message}`,
        assertions: [],
      });
      continue;
    }
    const engine = result as EngineResult;
    const [boundary] = engine.boundaries;
    const termini = terminiOf(job.input.workflow, engine);
    const kinds = termini.map((terminus) => ({
      terminus,
      kind: classifyTerminus(job.input.workflow, engine, terminus, outcomesFor(job.workflowFile)),
    }));

    outcomes.push(
      applyClassification(
        applyStructure(
          {
            ...evaluateThen(job.entry.then, engine, job.entry.id),
            workflow: job.shownAs,
            ...(job.entry.title === undefined ? {} : { title: job.entry.title }),
            ...(boundary === undefined
              ? {}
              : { boundary: { node: boundary.node, inputItems: boundary.inputItems } }),
          },
          // Shapes come from the walk that just ran, so a chain is judged
          // against what actually flowed through this case.
          checkStructure(job.input.workflow, engine),
        ),
        kinds,
        checkTerminalShape(engine, readCapture(job.workflowFile), termini),
      ),
    );
  }

  // Deterministic regardless of the order jobs finished in.
  outcomes.sort((a, b) => a.caseId.localeCompare(b.caseId) || (a.node ?? '').localeCompare(b.node ?? ''));

  const summary: RunSummary = {
    pass: outcomes.filter((o) => o.status === 'pass').length,
    fail: outcomes.filter((o) => o.status === 'fail').length,
    warn: outcomes.filter((o) => o.status === 'warn').length,
    needsExecution: outcomes.filter((o) => o.status === 'needs-execution').length,
    durationMs: performance.now() - started,
  };

  return {
    outcomes,
    summary,
    suites: suites.length,
    nodeTypes: {
      version: nodeTypes.n8nVersion,
      exact: nodeTypes.exact,
      ...(nodeTypes.sourceNote === undefined ? {} : { note: nodeTypes.sourceNote }),
    },
  };
}
