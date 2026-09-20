import type { FilterConditionValue, FilterValue, INodeExecutionData } from 'n8n-workflow';
import { executeFilter } from '../n8n.js';
import { ConditionEvaluationError, type Semantics } from '../types.js';

/**
 * Operators whose whole purpose is to test presence or emptiness. An undefined
 * operand is meaningful for these, not a defect.
 */
const EXISTENCE_OPERATIONS = new Set(['exists', 'notExists', 'empty', 'notEmpty']);

/**
 * Find an operand that resolved to undefined.
 *
 * n8n does *not* raise on this: `executeFilter` treats an undefined operand as
 * simply not matching and returns false, even under strict type validation. That
 * silently routes the item down the false branch, which is precisely the bug
 * class payload-contract exists to catch, so the engine detects it here instead — per spec
 * §4, undefined feeding an IF/Switch condition is a failure, not a warning.
 */
function undefinedOperand(
  conditions: FilterConditionValue[],
): { index: number; side: 'leftValue' | 'rightValue' } | undefined {
  for (const [index, condition] of conditions.entries()) {
    if (EXISTENCE_OPERATIONS.has(condition.operator?.operation)) continue;
    if (condition.leftValue === undefined) return { index, side: 'leftValue' };
    if (condition.operator?.singleValue !== true && condition.rightValue === undefined) {
      return { index, side: 'rightValue' };
    }
  }
  return undefined;
}

/**
 * Decide one item's conditions with n8n's own filter executor, after rejecting
 * comparisons that cannot be decided honestly. A type mismatch raised by n8n
 * itself (`FilterError`) is surfaced the same way.
 */
export function decide(
  conditions: FilterValue,
  itemIndex: number,
  nodeName: string,
  parameter = 'conditions',
): boolean {
  const missing = undefinedOperand(conditions?.conditions ?? []);
  if (missing !== undefined) {
    throw new ConditionEvaluationError(
      nodeName,
      parameter,
      `condition ${missing.index} compares ${missing.side} which resolved to undefined; ` +
        'n8n would route this item to the false branch without reporting anything',
      itemIndex,
      missing.index,
      missing.side,
    );
  }

  try {
    return executeFilter(conditions, { itemIndex });
  } catch (error) {
    throw new ConditionEvaluationError(
      nodeName,
      parameter,
      error instanceof Error ? error.message : String(error),
      itemIndex,
    );
  }
}

/** IF v2.x — output 0 is the matching branch, output 1 the rest. */
export const ifSemantics: Semantics = (ctx, input) => {
  const matched: INodeExecutionData[] = [];
  const rest: INodeExecutionData[] = [];

  input.forEach((item, index) => {
    const conditions = ctx.resolve(index).conditions as FilterValue;
    const branch = decide(conditions, index, ctx.node.name) ? matched : rest;
    branch.push({ ...item, pairedItem: { item: index } });
  });

  return { outputs: [matched, rest] };
};
