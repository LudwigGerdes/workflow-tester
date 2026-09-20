import { setOwn, type Shape } from './shape.js';

/**
 * Building a stand-in item from a recorded shape.
 *
 * A node that reaches outside the workflow cannot be run offline, so the walk
 * would stop there and everything downstream would go unverified. With a shape
 * recorded from a real run, the walk can substitute a stand-in and carry on:
 * you lose that node's internals, not the rest of the workflow.
 *
 * The values are invented, and deliberately so — a capture stores shape, never
 * data. That is the trade: expressions that *read* a field are verified, while
 * expressions that branch on a field's value are not. `substituted` in the
 * result marks which nodes these were, so a report never implies otherwise.
 */

/** Deterministic, so the same shape yields the same stand-in every run. */
const stringFor = (path: string): string => `«${path === '' ? 'value' : path}»`;

function build(shape: Shape, path: string): unknown {
  switch (shape.type) {
    case 'string':
      return stringFor(path);
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'array':
      // One element, so `.map` and `[0]` both find something. An empty array
      // would make every downstream read resolve to undefined, which is the
      // failure this exists to avoid rather than cause.
      return shape.items === undefined ? [] : [build(shape.items, `${path}[]`)];
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(shape.fields ?? {})) {
        setOwn(out, key, build(child, path === '' ? key : `${path}.${key}`));
      }
      return out;
    }
    default:
      return null;
  }
}

/** A single stand-in value matching the shape. */
export const synthesize = (shape: Shape): unknown => build(shape, '');

/**
 * A stand-in output for a node, as items.
 *
 * One item: the recorded item count is not reproduced, because a shape says
 * nothing about how many items a different input would produce. Fan-out is a
 * property of the run, not of the contract.
 */
export const synthesizeItems = (shape: Shape): Array<{ json: Record<string, unknown> }> => {
  const value = synthesize(shape);
  const json = (value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : { value }) as Record<string, unknown>;
  return [{ json }];
};
