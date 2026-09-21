import type { Io } from './io.js';

/**
 * Whether this environment writes fixtures or gates on them.
 *
 * A property of *where you are working*, not of the repository: the same
 * checkout is dev on a developer's machine and test in CI, so a committed file
 * would have to claim one and be wrong for the other.
 */
export type Mode = 'dev' | 'test';

/**
 * `test` is the default, and the default is deliberate: an environment that has
 * not opted in gates rather than rewrites. An unrecognised value falls back the
 * same way and is reported, because a typo that silently regenerated committed
 * fixtures would be the worst outcome of the two.
 */
export function modeOf(io: Io): Mode {
  const raw = io.env?.['WORKFLOW_TEST_MODE'];
  if (raw === undefined || raw.trim() === '') return 'test';
  const value = raw.trim().toLowerCase();
  if (value === 'dev' || value === 'test') return value;
  io.err(`workflow-test: unknown WORKFLOW_TEST_MODE "${raw.trim()}"; using test`);
  return 'test';
}
