import type { FilterValue, INodeExecutionData } from 'n8n-workflow';
import { UnsupportedModeError, type Semantics } from '../types.js';
import { decide } from './if.js';

interface Rule {
  conditions?: FilterValue;
  outputKey?: string;
}

/**
 * Switch v3 in `rules` mode. Each rule owns one output, in declaration order;
 * `outputKey` only names it and has no bearing on routing.
 *
 * `expression` mode computes its output index from an arbitrary expression per
 * item, which is a boundary rather than something to guess at.
 */
export const switchSemantics: Semantics = (ctx, input) => {
  const outputs: INodeExecutionData[][] = [];
  const ensure = (index: number): INodeExecutionData[] => {
    while (outputs.length <= index) outputs.push([]);
    return outputs[index] as INodeExecutionData[];
  };

  input.forEach((item, index) => {
    const params = ctx.resolve(index);
    if (params.mode === 'expression') {
      throw new UnsupportedModeError(
        ctx.node.name,
        'Switch in expression mode computes its output per item; tier 2 runs it',
      );
    }

    const collection = params.rules as { values?: Rule[] } | undefined;
    const rules = collection?.values ?? [];
    const options = (params.options ?? {}) as {
      allMatchingOutputs?: boolean;
      fallbackOutput?: string | number;
    };

    // Every rule owns an output whether or not it matched, and an `extra`
    // fallback owns one whether or not anything fell back — a real execution
    // records the empty output, so the shape of the result never depends on the
    // payload.
    ensure(Math.max(rules.length - 1, 0));
    if (options.fallbackOutput === 'extra') ensure(rules.length);

    const paired = { ...item, pairedItem: { item: index } };
    let matched = false;

    for (const [ruleIndex, rule] of rules.entries()) {
      if (rule.conditions === undefined) continue;
      if (!decide(rule.conditions, index, ctx.node.name, `rules.values[${ruleIndex}].conditions`)) {
        continue;
      }
      ensure(ruleIndex).push(paired);
      matched = true;
      if (options.allMatchingOutputs !== true) break;
    }

    if (matched) return;

    const fallback = options.fallbackOutput;
    if (fallback === undefined || fallback === 'none') return; // item is dropped
    if (fallback === 'extra') {
      ensure(rules.length).push(paired);
      return;
    }
    if (typeof fallback === 'number') ensure(fallback).push(paired);
  });

  return { outputs };
};
