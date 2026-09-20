import { synthesize, type CaptureRecord } from 'payload-contract-contracts';

export interface DerivedCase {
  id: string;
  title: string;
  payload: unknown;
}

/**
 * A case built from the capture itself.
 *
 * Without this, a workflow with a recorded execution and no hand-written tests
 * has nothing to run, and `run` reports a clean bill of health over a workflow
 * it never looked at. The capture already describes what the trigger receives,
 * so it can stand up one case on its own.
 *
 * The values are invented from the recorded shape and prove nothing by
 * themselves — what this case checks is that the workflow still resolves, and
 * that its endings still produce the shapes the capture recorded.
 */
export function caseFromCapture(
  capture: CaptureRecord | undefined,
  trigger: string,
): DerivedCase | undefined {
  if (capture === undefined || capture.awaitingFirstExecution === true) return undefined;
  const recorded = capture.nodes?.[trigger];
  if (recorded === undefined) return undefined;
  return {
    id: `capture:${trigger}`,
    title: `derived from the capture of ${trigger}`,
    payload: synthesize(recorded.shape),
  };
}
