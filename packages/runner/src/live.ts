/**
 * Live: run a case for real, on an n8n instance, against integration-mock.
 *
 * The offline walk covers the expression-pure part of a workflow offline. A live run sends
 * the payload to the workflow on an instance whose outbound calls hit the
 * mock, then judges the execution n8n recorded and the calls the mock saw.
 * The mock and the instance arrive as interfaces, so this module is testable
 * with fakes; the networked clients live in `workflow-tester-instance`.
 */
import { evaluatePath, matches, readExpectation } from './assert.js';
import type { AssertionOutcome, Outcome } from './oracle.js';
import { readSnapshotFile } from './snapshot.js';
import type { SuiteCase } from './types.js';

/** What a case's `given` asks of the mock. */
export interface MockGiven {
  packs?: string[];
  faults?: Record<string, unknown>;
  seed?: Record<string, Record<string, unknown[]>>;
  snapshot?: string;
}

/** One request the mock served, as its log reports it. */
export interface MockCall {
  ts: number;
  service: string;
  method: string;
  path: string;
  status: number;
  /** `unmatched` when no route answered; otherwise the route id or `passthrough`. */
  matchedRoute: string;
}

/** The mock's admin API, reduced to what a run needs. */
export interface MockControl {
  enablePacks(ids: string[]): Promise<void>;
  setFault(service: string, spec: unknown): Promise<void>;
  clearFaults(): Promise<void>;
  resetStores(): Promise<void>;
  clearSnapshot(): Promise<void>;
  activateSnapshot(snapshot: unknown): Promise<void>;
  seedStore(service: string, seed: Record<string, unknown[]>): Promise<void>;
  log(since: number): Promise<MockCall[]>;
}

/** Runs a workflow once and returns the execution n8n recorded. */
export interface InstanceRunner {
  run(input: { workflow: unknown; trigger: string; payload: unknown }): Promise<{ execution: unknown; id?: string }>;
}

export interface LiveJob {
  entry: SuiteCase;
  /** Repo-relative path, for reports. */
  shownAs: string;
  workflow: unknown;
  trigger: string;
  payload: unknown;
  /** The test file the case came from; `given.snapshot` is relative to it. */
  testFile: string;
}

export interface LiveDeps {
  mock: MockControl;
  instance: InstanceRunner;
  now?: () => number;
}


const MOCK_GIVEN_KEYS = ['packs', 'faults', 'seed', 'snapshot'] as const;

/** The `given` keys only a mock can honour, if the case has any. */
export function mockGivenOf(given: Record<string, unknown> | undefined): MockGiven | undefined {
  if (given === undefined) return undefined;
  const out: MockGiven = {};
  for (const key of MOCK_GIVEN_KEYS) {
    if (given[key] !== undefined) (out as Record<string, unknown>)[key] = given[key];
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export type MockNeed = 'none' | 'snapshot-only' | 'mock';

/**
 * What a case asks of a mock: nothing, only a snapshot (a file, so it runs
 * offline), or a running mock (`--mock` or `--live`).
 */
export function mockNeedOf(entry: SuiteCase): MockNeed {
  const given = mockGivenOf(entry.given);
  const judgesCalls = entry.then?.['calls'] !== undefined || entry.then?.['noUnmatched'] !== undefined;
  if (given === undefined && !judgesCalls) return 'none';
  const keys = Object.keys(given ?? {});
  return !judgesCalls && keys.length === 1 && keys[0] === 'snapshot' ? 'snapshot-only' : 'mock';
}

/** Does this case need a running mock: `packs`, `faults`, `seed`, or `then.calls`/`noUnmatched`? */
export const needsLive = (entry: SuiteCase): boolean => mockNeedOf(entry) === 'mock';

interface RunData {
  [node: string]: Array<{ data?: { main?: Array<Array<{ json?: unknown }> | null> }; error?: unknown }>;
}

/** The items a node emitted across its runs and outputs, in order. */
function outputsOf(execution: unknown, node: string): Array<{ json?: unknown }> {
  const exec = execution as { data?: { resultData?: { runData?: RunData } }; resultData?: { runData?: RunData } };
  const runs = exec.data?.resultData?.runData?.[node] ?? exec.resultData?.runData?.[node] ?? [];
  return runs.flatMap((run) => (run.data?.main ?? []).flatMap((branch) => branch ?? []));
}

function executionStatus(execution: unknown): { status: string; errorNode?: string } {
  const exec = execution as {
    status?: unknown;
    finished?: unknown;
    data?: { resultData?: { error?: { node?: { name?: unknown } } } };
  };
  const errorNode = exec.data?.resultData?.error?.node?.name;
  const status = typeof exec.status === 'string' ? exec.status : exec.finished === true ? 'success' : 'error';
  return { status, ...(typeof errorNode === 'string' ? { errorNode } : {}) };
}

/** A `then.calls` row: how many calls to a service (and method, and path) the mock should have seen. */
interface CallAssertion {
  service?: string;
  method?: string;
  path?: string;
  count?: number;
  gte?: number;
  lte?: number;
}

const pathMatches = (pattern: string | undefined, path: string): boolean => {
  if (pattern === undefined) return true;
  if (!pattern.includes('*')) return path === pattern;
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(path);
};

function checkCalls(raw: unknown, calls: MockCall[]): AssertionOutcome[] {
  if (!Array.isArray(raw)) {
    return [{ path: 'calls', status: 'fail', expected: raw, message: 'calls must be a list' }];
  }
  return raw.map((row: unknown, i): AssertionOutcome => {
    const a = (row ?? {}) as CallAssertion;
    const seen = calls.filter(
      (c) =>
        (a.service === undefined || c.service === a.service) &&
        (a.method === undefined || c.method === a.method) &&
        pathMatches(a.path, c.path),
    ).length;
    const wanted =
      a.count !== undefined ? seen === a.count : (a.gte === undefined || seen >= a.gte) && (a.lte === undefined || seen <= a.lte);
    const label = [a.method, a.service, a.path].filter((s) => s !== undefined).join(' ');
    return {
      path: `calls[${i}]`,
      status: wanted ? 'pass' : 'fail',
      expected: a.count ?? { ...(a.gte === undefined ? {} : { gte: a.gte }), ...(a.lte === undefined ? {} : { lte: a.lte }) },
      actual: seen,
      ...(wanted ? {} : { message: `the mock saw ${seen} call(s) matching ${label || 'anything'}` }),
    };
  });
}

/** `then.calls` and `then.noUnmatched` against the calls the mock served. */
export function evaluateMockCalls(then: SuiteCase['then'] | undefined, calls: MockCall[]): AssertionOutcome[] {
  const only = Object.fromEntries(Object.entries(then ?? {}).filter(([k]) => k === 'calls' || k === 'noUnmatched'));
  return evaluateLive(only, { status: 'success' }, calls);
}

/** Judge a case's `then` against what n8n recorded and what the mock saw. */
export function evaluateLive(then: SuiteCase['then'] | undefined, execution: unknown, calls: MockCall[]): AssertionOutcome[] {
  const assertions: AssertionOutcome[] = [];
  const { status, errorNode } = executionStatus(execution);

  for (const [key, raw] of Object.entries(then ?? {})) {
    if (key === 'calls') {
      assertions.push(...checkCalls(raw, calls));
      continue;
    }
    if (key === 'noUnmatched') {
      const unmatched = calls.filter((c) => c.matchedRoute === 'unmatched');
      const ok = raw !== true || unmatched.length === 0;
      assertions.push({
        path: key,
        status: ok ? 'pass' : 'fail',
        expected: raw,
        actual: unmatched.length,
        ...(ok ? {} : { message: `${unmatched.length} call(s) no route answered: ${unmatched.map((c) => `${c.method} ${c.service}${c.path}`).join(', ')}` }),
      });
      continue;
    }
    if (key === 'execution.status' || key === 'execution') {
      const expected = key === 'execution' ? (raw as { status?: unknown })?.status : raw;
      const wantNode = typeof expected === 'object' && expected !== null ? (expected as { errorNode?: unknown }).errorNode : undefined;
      const ok = wantNode !== undefined ? status === 'error' && errorNode === wantNode : expected === status;
      assertions.push({ path: 'execution.status', status: ok ? 'pass' : 'fail', expected, actual: wantNode !== undefined ? { errorNode } : status });
      continue;
    }
    if (key === 'execution.errorNode') {
      assertions.push({ path: key, status: errorNode === raw ? 'pass' : 'fail', expected: raw, actual: errorNode });
      continue;
    }
    const m = /^node\.(.+?)\.(items|output.*)$/.exec(key);
    if (!m) {
      assertions.push({ path: key, status: 'fail', expected: raw, message: `unknown expectation "${key}"` });
      continue;
    }
    const emitted = outputsOf(execution, m[1]!);
    const { matcher, expected } = readExpectation(raw);
    if (m[2] === 'items') {
      const ok = matches({ items: emitted.length }, 'items', matcher, expected);
      assertions.push({ path: key, status: ok ? 'pass' : 'fail', expected, actual: emitted.length });
      continue;
    }
    const found = evaluatePath({ output: emitted }, m[2]!);
    assertions.push({
      path: key,
      status: matches({ output: emitted }, m[2]!, matcher, expected) ? 'pass' : 'fail',
      expected,
      actual: found.length === 1 ? found[0] : found,
    });
  }
  return assertions;
}

const isSeed = (v: unknown): v is Record<string, unknown[]> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => Array.isArray(x));

/**
 * Put the mock in the state a case asks for. Faults are replaced wholesale.
 * The snapshot goes after packs (enabling packs replaces the set, activating
 * a snapshot adds to it) and the seed after the snapshot (activating one
 * clears every store).
 */
export async function applyGiven(mock: MockControl, given: MockGiven | undefined, opts: { snapshot?: unknown }): Promise<void> {
  await mock.clearFaults();
  await mock.clearSnapshot();
  await mock.resetStores();
  if (given?.packs !== undefined) await mock.enablePacks(given.packs);
  if (opts.snapshot !== undefined) await mock.activateSnapshot(opts.snapshot);
  for (const [service, seed] of Object.entries(given?.seed ?? {})) {
    if (!isSeed(seed)) throw new Error(`given.seed.${service} must map each collection to a list of records`);
    await mock.seedStore(service, seed);
  }
  for (const [service, spec] of Object.entries(given?.faults ?? {})) await mock.setFault(service, spec);
}

/** Run each job on the instance against the mock, one at a time: the mock's state is shared. */
export async function runLive(jobs: LiveJob[], deps: LiveDeps): Promise<Outcome[]> {
  const now = deps.now ?? Date.now;
  const outcomes: Outcome[] = [];
  for (const job of jobs) {
    const given = mockGivenOf(job.entry.given);
    const began = now();
    let execution: unknown;
    let id: string | undefined;
    try {
      const snapshot = given?.snapshot === undefined ? undefined : readSnapshotFile(job.testFile, given.snapshot);
      await applyGiven(deps.mock, given, { snapshot });
      const since = now();
      ({ execution, id } = await deps.instance.run({ workflow: job.workflow, trigger: job.trigger, payload: job.payload }));
      const calls = await deps.mock.log(since);
      const assertions = evaluateLive(job.entry.then, execution, calls);
      const failed = assertions.filter((a) => a.status === 'fail');
      outcomes.push({
        caseId: job.entry.id,
        workflow: job.shownAs,
        ...(job.entry.title === undefined ? {} : { title: job.entry.title }),
        status: failed.length === 0 ? 'pass' : 'fail',
        mode: 'live',
        message:
          failed.length === 0
            ? `ran on the instance against the mock: ${calls.length} call(s) served`
            : (failed[0]?.message ?? `${failed.length} expectation(s) failed`),
        assertions,
        durationMs: now() - began,
        ...(id === undefined ? {} : { executionId: id }),
      });
    } catch (error) {
      outcomes.push({
        caseId: job.entry.id,
        workflow: job.shownAs,
        ...(job.entry.title === undefined ? {} : { title: job.entry.title }),
        status: 'fail',
        mode: 'live',
        message: error instanceof Error ? error.message : String(error),
        assertions: [],
        durationMs: now() - began,
      });
    }
  }
  return outcomes;
}
