import type { Semantics } from '../types.js';

/**
 * `Stop and Error` ends the run on purpose.
 *
 * It is not a defect, and the distinction is invisible in an execution export:
 * the captured fixtures show a deliberate stop and an unhandled throw producing
 * the same node status, the same absent `main`, and the same errored run. Only
 * the node type tells them apart, which is why this is its own semantics rather
 * than a pattern matched against an error message.
 */
export class DeliberateStopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliberateStopError';
  }
}

export const stopAndError: Semantics = (ctx) => {
  const resolved = ctx.resolve(0);
  const message = resolved['errorMessage'];
  throw new DeliberateStopError(
    typeof message === 'string' && message !== '' ? message : 'workflow stopped with an error',
  );
};
