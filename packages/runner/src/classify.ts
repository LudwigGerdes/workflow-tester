import type { OutcomeDeclaration } from 'workflow-test-contracts';
import type { EngineResult } from 'workflow-test-engine';
import type { WorkflowJson } from 'workflow-test-generator';
import type { Terminus } from './termini.js';
import type { TerminalShapeReport } from './terminal-shape.js';
import type { Outcome } from './oracle.js';

export type TerminusKind = 'happy' | 'known-unhappy' | 'unknown';

const STOP_AND_ERROR = 'n8n-nodes-base.stopAndError';

/**
 * Which ending is this?
 *
 * Inferred first, declared second. Inference has to exist for any of this to
 * work on a workflow that has never heard of workflow-test, and the premise of
 * `capture` is that whatever needs a human to write it does not get written. A
 * declaration corrects a wrong guess; it is not the mechanism.
 *
 * Nothing here reads execution status, and that is deliberate: a captured
 * export shows a node that threw into its error output still reporting
 * `executionStatus: success`, so status cannot tell the paths apart. The output
 * index can.
 */
export function classifyTerminus(
  workflow: WorkflowJson,
  result: EngineResult,
  terminus: Terminus,
  declared: OutcomeDeclaration[],
): TerminusKind {
  const declaration = declared.find((d) => d.node === terminus.node);
  if (declaration !== undefined) {
    return declaration.expect === 'failure' ? 'known-unhappy' : 'happy';
  }

  const node = workflow.nodes.find((n) => n.name === terminus.node);
  if (node?.type === STOP_AND_ERROR) return 'known-unhappy';

  // Reached through the error output of a node that declared one. The error
  // output is always the last, so any output past the first on such a node is it.
  const via = terminus.via;
  if (via !== undefined && result.errorOutputs.includes(via.node) && via.output > 0) {
    return 'known-unhappy';
  }

  const failure = result.failures.find((f) => f.node === terminus.node);
  if (failure !== undefined) {
    return failure.kind === 'deliberate-stop' ? 'known-unhappy' : 'unknown';
  }

  return 'happy';
}

/**
 * Fold the classification and the shape contract into an outcome.
 *
 * The two steps stay separate up to here on purpose: *which ending did we
 * reach* and *did it carry what it should* are independently answerable, and
 * folding them earlier leaves a happy terminus with a broken contract nowhere
 * to go.
 *
 * A happy ending carrying the wrong payload is red, not yellow — arriving at
 * the right place with the wrong cargo is a failure, not a known conclusion. A
 * known-unhappy ending is not shape-checked at all: its author declared it a
 * failure path, so what it emits is not a success criterion.
 */
export function applyClassification(
  outcome: Outcome,
  kinds: Array<{ terminus: Terminus; kind: TerminusKind }>,
  shapes: TerminalShapeReport,
): Outcome {
  if (kinds.length === 0) return outcome;

  const classification = kinds.map(({ terminus, kind }) => ({ node: terminus.node, kind }));
  const happy = (node: string): boolean =>
    kinds.some((k) => k.kind === 'happy' && k.terminus.node === node);
  const broken = shapes.findings.filter((f) => happy(f.node));
  const unchecked = shapes.unchecked.filter(happy);
  const unknown = kinds.filter((k) => k.kind === 'unknown');
  const knownUnhappy = kinds.filter((k) => k.kind === 'known-unhappy');

  let status = outcome.status;
  let message = outcome.message;

  /**
   * Classification explains *which ending*; the oracle explains *what broke*.
   * The second is the more useful of the two, so when the case already failed
   * with a diagnosis of its own that diagnosis leads and this is appended.
   * Overwriting it trades "the condition at Check resolved to undefined" for a
   * category, which is a worse report.
   */
  const say = (text: string): void => {
    message = outcome.status === 'fail' && outcome.message !== '' ? `${outcome.message} — ${text}` : text;
  };

  if (unknown.length > 0) {
    status = 'fail';
    say(
      `reached an ending your error handling does not account for: ${unknown
        .map((k) => k.terminus.node)
        .join(', ')}`,
    );
  } else if (broken.length > 0) {
    status = 'fail';
    const detail = broken
      .map((f) => `${f.node} (${f.changes.map((c) => `${c.path} ${c.detail}`).join('; ')})`)
      .join(', ');
    say(`an ending stopped producing what it used to: ${detail}`);
  } else if (outcome.status === 'pass' && knownUnhappy.length > 0) {
    status = 'warn';
    say(`reached a known failure path: ${knownUnhappy.map((k) => k.terminus.node).join(', ')}`);
  } else if (outcome.status === 'pass' && unchecked.length > 0) {
    status = 'warn';
    say(`no recorded shape for ${unchecked.join(', ')}; nothing was checked there`);
  }

  // A case that already failed stays failed — with one exception. When every
  // ending it reached is a *known* one and none is unknown, the failure the
  // engine recorded IS that known ending: a Stop and Error is a deliberate
  // conclusion, and reporting it red would mean a workflow cannot say "stop
  // here" without breaking its own build. A real defect alongside it still
  // shows, because the node it broke at is a terminus too and classifies as
  // unknown.
  const allEndingsKnown =
    kinds.length > 0 && kinds.every((k) => k.kind === 'known-unhappy') && unknown.length === 0;
  if (outcome.status === 'fail' && !allEndingsKnown) status = 'fail';
  if (outcome.status === 'fail' && allEndingsKnown) {
    status = 'warn';
    say(`reached a known failure path: ${knownUnhappy.map((k) => k.terminus.node).join(', ')}`);
  }
  return { ...outcome, status, message, classification };
}
