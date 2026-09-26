import { describe, expect, it } from 'vitest';
import type { EngineResult } from 'workflow-tester-engine';
import type { WorkflowJson } from 'workflow-tester-generator';
import { applyStructure, checkStructure } from '../src/structure-check.js';
import type { Outcome } from '../src/oracle.js';

/** A webhook feeding a Set node whose one assignment reads `sku` somehow. */
const workflowWith = (skuExpression: string): WorkflowJson => ({
  nodes: [
    { name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, parameters: {} },
    {
      name: 'Edit',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      parameters: {
        assignments: { assignments: [{ name: 'sku', type: 'string', value: skuExpression }] },
      },
    },
  ],
  connections: { Webhook: { main: [[{ node: 'Edit', index: 0 }]] } },
});

/** `items` is an array, so reading `.sku` straight off it is the defect. */
const result = {
  status: 'pass',
  reachedNodes: ['Webhook', 'Edit'],
  outputs: {
    Webhook: [[{ json: { body: { items: [{ sku: 'A' }] } } }]],
    Edit: [[{ json: { sku: 'A' } }]],
  },
  failures: [],
  warnings: [],
  boundaries: [],
  substituted: [],
  durationMs: 0,
} as unknown as EngineResult;

describe('checkStructure', () => {
  it('reports a field read off an array, against the predecessor output', () => {
    const report = checkStructure(workflowWith('={{ $json.body.items.sku }}'), result);
    expect(report.findings).toHaveLength(1);
    const [finding] = report.findings;
    expect(finding?.kind).toBe('container-mismatch');
    expect(finding?.node).toBe('Edit');
    expect(finding?.chain).toBe('body.items.sku');
    expect(finding?.parameter).toContain('assignments');
  });

  it('counts a chain it could not resolve a shape for', () => {
    const noOutputs = { ...result, outputs: {} } as unknown as EngineResult;
    const report = checkStructure(workflowWith('={{ $json.body.items.sku }}'), noOutputs);
    expect(report.findings).toEqual([]);
    expect(report.unresolved).toBe(1);
  });

  it('resolves a named-node root against that node output', () => {
    const report = checkStructure(
      workflowWith("={{ $('Webhook').item.json.body.items.sku }}"),
      result,
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.kind).toBe('container-mismatch');
  });

  it('says nothing when the chain matches the shape', () => {
    const report = checkStructure(workflowWith('={{ $json.body.items[0].sku }}'), result);
    expect(report.findings).toEqual([]);
  });
});

describe('applyStructure', () => {
  const base: Outcome = {
    caseId: 'c1',
    status: 'pass',
    mode: 'offline',
    message: 'ok',
    assertions: [],
  };

  it('fails a passing outcome when a finding is a failure', () => {
    const out = applyStructure(base, {
      findings: [
        {
          kind: 'container-mismatch',
          severity: 'fail',
          at: 'items',
          message: 'read field "sku" on an array',
          node: 'Edit',
          parameter: 'p',
          chain: 'items.sku',
        },
      ],
      unresolved: 0,
    });
    expect(out.status).toBe('fail');
    expect(out.structure).toHaveLength(1);
  });

  it('warns a passing outcome when every finding is a warning', () => {
    const out = applyStructure(base, {
      findings: [
        {
          kind: 'index-out-of-range',
          severity: 'warn',
          at: 'items[7]',
          message: 'index 7 on an array that held at most 5',
          node: 'Edit',
          parameter: 'p',
          chain: 'items[7]',
        },
      ],
      unresolved: 0,
    });
    expect(out.status).toBe('warn');
  });

  it('never downgrades an outcome that already failed', () => {
    const failed: Outcome = { ...base, status: 'fail' };
    const out = applyStructure(failed, { findings: [], unresolved: 3 });
    expect(out.status).toBe('fail');
  });

  it('leaves a clean outcome alone', () => {
    expect(applyStructure(base, { findings: [], unresolved: 0 })).toEqual(base);
  });
});
