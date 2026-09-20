import { describe, expect, it } from 'vitest';
import {
  Expression,
  ExpressionError,
  NodeHelpers,
  Workflow,
  WorkflowDataProxy,
  WorkflowExpression,
  executeFilter,
} from '../src/n8n.js';

describe('n8n-workflow loader shim', () => {
  it('exposes the constructors the engine reuses', () => {
    for (const ctor of [Workflow, WorkflowExpression, Expression, WorkflowDataProxy, ExpressionError]) {
      expect(typeof ctor).toBe('function');
    }
  });

  it('exposes the evaluators the engine must never reimplement', () => {
    expect(typeof executeFilter).toBe('function');
    expect(typeof NodeHelpers.getNodeParameters).toBe('function');
    expect(typeof NodeHelpers.displayParameter).toBe('function');
  });
});
