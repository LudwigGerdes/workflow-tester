import type { EngineResult } from 'workflow-tester-engine';
import { evaluatePath, matches, readExpectation } from './assert.js';
import type { SuiteCase } from './types.js';

export type OutcomeStatus = 'pass' | 'fail' | 'warn' | 'needs-execution';

export interface AssertionOutcome {
  path: string;
  status: OutcomeStatus;
  expected?: unknown;
  actual?: unknown;
  message?: string;
}

export interface Outcome {
  caseId: string;
  /** Workflow the case ran against; set by the runner, used by the reporters. */
  workflow?: string;
  title?: string;
  /**
   * Where tier 1 stopped, and what it had computed by then. A real run can be
   * pinned to that node with these items, so it skips the prefix the engine
   * already verified.
   */
  boundary?: { node: string; inputItems: unknown[] };
  /**
   * Nodes whose output was a stand-in from a recorded capture rather than
   * computed. Verified against a stand-in is a weaker claim than verified.
   */
  substituted?: string[];
  status: OutcomeStatus;
  tier: 1;
  node?: string;
  parameter?: string;
  expression?: string;
  resolvedPath?: string;
  message: string;
  assertions: AssertionOutcome[];
  /**
   * Structural misuse of the data — a field read off an array, an index past
   * every observed length, a key that is not produced. Reported alongside the
   * expression verdict rather than folded into it, because the cause and the
   * symptom are different findings.
   */
  structure?: import('./structure-check.js').StructureFinding[];
  /** Which ending each terminus was, for `explain` and the reporters. */
  classification?: Array<{ node: string; kind: import('./classify.js').TerminusKind }>;
}

const worst = (statuses: OutcomeStatus[]): OutcomeStatus => {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('needs-execution')) return 'needs-execution';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
};

/** Did the run reach this node and interpret it? */
const isPure = (result: EngineResult, node: string): boolean =>
  result.outputs[node] !== undefined;

/**
 * Judge a case that carries no expectations, per spec §4.
 *
 * This is the oracle the generated cases run under: workflow-tester generates inputs, not
 * expected outputs, so what makes a case a failure is the engine's own verdict —
 * an expression that could not resolve where the result depends on it.
 */
export function oracle(result: EngineResult, caseId = ''): Outcome {
  const stood = result.substituted.length > 0 ? { substituted: result.substituted } : {};
  const [failure] = result.failures;
  if (failure !== undefined) {
    return {
      caseId,
      status: 'fail',
      tier: 1,
      node: failure.node,
      parameter: failure.parameter,
      ...(failure.expression === undefined ? {} : { expression: failure.expression }),
      ...(failure.resolvedPath === undefined ? {} : { resolvedPath: failure.resolvedPath }),
      message: failure.message,
      assertions: [],
    };
  }

  const [boundary] = result.boundaries;
  if (boundary !== undefined) {
    return {
      caseId,
      status: 'needs-execution',
      tier: 1,
      node: boundary.node,
      message: `verified up to ${boundary.node} (${boundary.type}); running past it needs a real execution`,
      assertions: [],
    };
  }

  const [warning] = result.warnings;
  if (warning !== undefined) {
    return {
      caseId,
      status: 'warn',
      tier: 1,
      node: warning.node,
      ...(warning.parameter === undefined ? {} : { parameter: warning.parameter }),
      message: warning.message,
      assertions: [],
    };
  }

  return {
    caseId,
    status: 'pass',
    tier: 1,
    message: 'every expression resolved',
    assertions: [],
    ...stood,
  };
}

/**
 * Evaluate a case's declared expectations against a tier-1 result.
 *
 * Keys are a flat dotted form — `execution.status`,
 * `node.Slack.items`, `node.Fetch.output[0].json.id` — with the nested
 * `execution:` / `node:` objects also understood, since both appear in the
 * owner's own fixture.
 *
 * Anything only a real execution can answer — an assertion on a node past a
 * boundary, or on outbound calls — reports `needs-execution` rather than passing or
 * failing, so a user sees exactly which expectations a real execution would
 * have to run. An expectation this evaluator does not recognise says so too,
 * rather than being quietly dropped.
 */
export function evaluateThen(
  then: SuiteCase['then'] | undefined,
  result: EngineResult,
  caseId = '',
): Outcome {
  if (then === undefined || Object.keys(then).length === 0) {
    return oracle(result, caseId);
  }

  const assertions: AssertionOutcome[] = [];
  const failedBeforeBoundary = result.failures.length > 0;

  const checkExecutionStatus = (path: string, expected: unknown): void => {
    // A run that stopped at a boundary has no final status to compare against,
    // unless it had already failed before reaching it.
    if (result.status === 'boundary' && !failedBeforeBoundary) {
      const [boundary] = result.boundaries;
      assertions.push({
        path,
        status: 'needs-execution',
        expected,
        message:
          boundary === undefined
            ? 'the run stopped at a boundary, so its final status needs a real execution'
            : `the run stopped at ${boundary.node} (a boundary: a node workflow-tester cannot run offline), ` +
              'so its final status needs a real execution',
      });
      return;
    }
    const actual = result.status === 'fail' ? 'error' : 'success';
    assertions.push({ path, status: actual === expected ? 'pass' : 'fail', expected, actual });
  };

  const checkErrorNode = (path: string, expected: unknown): void => {
    const actual = result.failures[0]?.node;
    assertions.push({ path, status: actual === expected ? 'pass' : 'fail', expected, actual });
  };

  /** `node.<Name>.<rest>` — items count, or a path into the emitted items. */
  const checkNode = (path: string, node: string, rest: string, raw: unknown): void => {
    if (result.outputs[node] === undefined) {
      assertions.push({
        path,
        status: 'needs-execution',
        expected: raw,
        message: result.reachedNodes.includes(node)
          ? `${node} is past a boundary`
          : `${node} was not reached at tier 1`,
      });
      return;
    }

    // `output[i]` indexes the node's items — the same list `items` counts.
    const emitted = (result.outputs[node] ?? []).flat();
    const { matcher, expected } = readExpectation(raw);

    if (rest === 'items') {
      assertions.push({
        path,
        status: matches({ items: emitted }, 'items', matcher === 'equals' ? 'count' : matcher, expected)
          ? 'pass'
          : 'fail',
        expected,
        actual: emitted.length,
      });
      return;
    }

    const found = evaluatePath({ output: emitted }, rest);
    assertions.push({
      path,
      status: matches({ output: emitted }, rest, matcher, expected) ? 'pass' : 'fail',
      expected,
      actual: found.length === 1 ? found[0] : found,
    });
  };

  for (const [key, raw] of Object.entries(then)) {
    if (key === 'calls' || key === 'noUnmatched') {
      assertions.push({
        path: key,
        status: 'needs-execution',
        expected: raw,
        message:
          key === 'calls'
            ? 'outbound calls are only observable in a real execution'
            : 'unmatched calls are only observable in a real execution',
      });
      continue;
    }

    if (key === 'execution.status') {
      checkExecutionStatus(key, raw);
      continue;
    }
    if (key === 'execution.errorNode') {
      checkErrorNode(key, raw);
      continue;
    }

    if (key === 'execution' && raw !== null && typeof raw === 'object') {
      const nested = raw as { status?: unknown; errorNode?: unknown };
      if (typeof nested.status === 'string') checkExecutionStatus('execution.status', nested.status);
      if (typeof nested.errorNode === 'string') checkErrorNode('execution.errorNode', nested.errorNode);
      if (typeof nested.status !== 'string' && typeof nested.errorNode !== 'string') {
        assertions.push({
          path: key,
          status: 'needs-execution',
          expected: raw,
          message: 'this execution expectation is not one tier 1 can evaluate',
        });
      }
      continue;
    }

    if (key === 'node' && raw !== null && typeof raw === 'object') {
      for (const [node, expectations] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
        for (const [rest, value] of Object.entries(expectations)) {
          checkNode(`node.${node}.${rest}`, node, rest, value);
        }
      }
      continue;
    }

    if (key.startsWith('node.')) {
      const [, node, ...rest] = key.split('.');
      if (node !== undefined && rest.length > 0) {
        checkNode(key, node, rest.join('.'), raw);
        continue;
      }
    }

    assertions.push({
      path: key,
      status: 'needs-execution',
      expected: raw,
      message: `tier 1 does not know how to evaluate "${key}"`,
    });
  }

  const status = worst(assertions.map((assertion) => assertion.status));
  const failure = status === 'fail' ? result.failures[0] : undefined;

  // A case with expectations rested on the same stand-ins as one without;
  // the report has to say so either way.
  return {
    caseId,
    status,
    tier: 1,
    ...(result.substituted.length > 0 ? { substituted: result.substituted } : {}),
    ...(failure === undefined ? {} : { node: failure.node, parameter: failure.parameter }),
    ...(failure?.resolvedPath === undefined ? {} : { resolvedPath: failure.resolvedPath }),
    message:
      status === 'pass'
        ? 'every expectation held'
        : (assertions.find((a) => a.status === status)?.message ??
          `${assertions.filter((a) => a.status === status).length} expectation(s) ${status}`),
    assertions,
  };
}
