import type { Semantics } from '../types.js';

/** NoOp forwards its input untouched, re-pairing each item with its index. */
export const noOpSemantics: Semantics = (_ctx, input) => ({
  outputs: [input.map((item, index) => ({ ...item, pairedItem: { item: index } }))],
});
