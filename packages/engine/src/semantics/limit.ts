import type { INodeExecutionData } from 'n8n-workflow';
import type { Semantics } from '../types.js';

/** Limit v1 — keep the first or last N items, re-pairing each to its source. */
export const limitSemantics: Semantics = (ctx, input) => {
  const params = ctx.resolve(0);
  const maxItems = Number(params.maxItems ?? 1);
  const keep = (params.keep as string | undefined) ?? 'firstItems';

  const withPairing = input.map((item, index) => ({ ...item, pairedItem: { item: index } }));
  const limit = Number.isFinite(maxItems) && maxItems >= 0 ? maxItems : withPairing.length;

  const kept: INodeExecutionData[] =
    keep === 'lastItems' ? withPairing.slice(Math.max(0, withPairing.length - limit)) : withPairing.slice(0, limit);

  return { outputs: [kept] };
};
