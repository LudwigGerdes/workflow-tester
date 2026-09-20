import type { FilterValue, INodeExecutionData } from 'n8n-workflow';
import type { Semantics } from '../types.js';
import { decide } from './if.js';

/**
 * Filter v2.x — kept items on output 0, discarded on output 1.
 *
 * Both outputs are always produced. The static description declares a single
 * output, which is what the engine originally followed, but a real execution
 * records two regardless of `keepDiscardedItems` — the captured execution is what
 * settled it. Only output 0 is connectable in the editor, so the walker does not
 * treat the discarded items as a dead branch.
 */
export const filterSemantics: Semantics = (ctx, input) => {
  const kept: INodeExecutionData[] = [];
  const discarded: INodeExecutionData[] = [];

  input.forEach((item, index) => {
    const conditions = ctx.resolve(index).conditions as FilterValue;
    const branch = decide(conditions, index, ctx.node.name) ? kept : discarded;
    branch.push({ ...item, pairedItem: { item: index } });
  });

  return { outputs: [kept, discarded] };
};
