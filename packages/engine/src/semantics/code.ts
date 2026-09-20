import type { INodeExecutionData } from 'n8n-workflow';
import { UnsupportedModeError, type Semantics, type Warning } from '../types.js';
import { buildCodeContext } from './code-context.js';
import { evaluateCode } from './code-eval.js';
import { normalizeAllItems, normalizeEachItem } from './code-result.js';

/**
 * Interpret a Code node.
 *
 * Code nodes hold the logic a workflow actually performs, and until now they
 * ended their path as a boundary — the one node kind most worth verifying was
 * the one kind never verified. A Code node is a pure function of its input
 * right up until it reaches outside itself, which is the only point where this
 * has to stop.
 */
export const codeSemantics: Semantics = (ctx, input) => {
  const node = ctx.node.name;
  const params = ctx.resolve(0);

  // Python runs on Pyodide, a different runtime entirely. Declining is honest;
  // attempting it would be a guess dressed up as a result.
  const language = (params['language'] as string | undefined) ?? 'javaScript';
  if (language !== 'javaScript') {
    throw new UnsupportedModeError(node, `Code node language "${language}" is not interpreted`);
  }

  const source = (params['jsCode'] as string | undefined) ?? '';
  const mode = (params['mode'] as string | undefined) ?? 'runOnceForAllItems';

  const warnings: Warning[] = [];
  const surface = (logs: string[]): void => {
    for (const message of logs) warnings.push({ kind: 'code-log', node, message });
  };

  if (mode === 'runOnceForEachItem') {
    const out: INodeExecutionData[] = input.map((_item, index) => {
      const { context, logs } = buildCodeContext({
        node,
        proxy: ctx.dataProxy(index),
        seed: `${node}:${index}`,
      });
      const result = normalizeEachItem(evaluateCode(source, context, node), node, index);
      surface(logs);
      return result;
    });
    return { outputs: [out], warnings };
  }

  const { context, logs } = buildCodeContext({
    node,
    proxy: ctx.dataProxy(0),
    seed: `${node}:all`,
  });
  const outputs = [normalizeAllItems(evaluateCode(source, context, node), node)];
  surface(logs);
  return { outputs, warnings };
};
