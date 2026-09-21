import { beforeAll, describe, expect, it } from 'vitest';
import type { INode, INodeExecutionData } from 'n8n-workflow';
import { buildWorkflow } from '../src/workflow.js';
import { loadNodeTypes, type NodeTypeSource } from '../src/node-types.js';
import { RunData, resolveParameters } from '../src/evaluate.js';
import { ParameterEvaluationError, type WorkflowJson } from '../src/types.js';

const setNode = (value: string): INode => ({
  parameters: {
    mode: 'manual',
    includeOtherFields: false,
    assignments: {
      assignments: [{ id: 'a1', name: 'out', value, type: 'string' }],
    },
    options: {},
  },
  id: 'set-1',
  name: 'Extract',
  type: 'n8n-nodes-base.set',
  typeVersion: 3.4,
  position: [220, 0],
});

const workflowWith = (node: INode): WorkflowJson => ({
  id: 'w',
  name: 'w',
  nodes: [
    {
      parameters: { httpMethod: 'POST', path: 'w', options: {} },
      id: 'wh-1',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 0],
    },
    node,
  ],
  connections: { Webhook: { main: [[{ node: node.name, type: 'main', index: 0 }]] } },
});

const TRIGGER_ITEMS: INodeExecutionData[] = [
  { json: { body: { email: 'a@x.io' } }, pairedItem: { item: 0 } },
];

/** Resolve the Set node's assignments with the webhook output already in run data. */
const resolveValue = async (types: NodeTypeSource, value: string): Promise<unknown> => {
  const node = setNode(value);
  const wf = buildWorkflow(workflowWith(node), types);
  const runData = new RunData();
  runData.setOutputs('Webhook', [TRIGGER_ITEMS]);
  const resolved = resolveParameters(wf, wf.getNode('Extract') as INode, runData, TRIGGER_ITEMS, 0);
  const assignments = resolved.assignments as { assignments: Array<{ value: unknown }> };
  return assignments.assignments[0]?.value;
};

describe('resolveParameters', () => {
  let types: NodeTypeSource;
  beforeAll(async () => {
    types = await loadNodeTypes();
  });

  it('resolves $json against the connected input items', async () => {
    expect(await resolveValue(types, '={{ $json.body.email }}')).toBe('a@x.io');
  });

  it('resolves $(...).item back through the paired item', async () => {
    expect(await resolveValue(types, "={{ $('Webhook').item.json.body.email }}")).toBe('a@x.io');
  });

  it('resolves $(...).first() without a paired item', async () => {
    expect(await resolveValue(types, "={{ $('Webhook').first().json.body.email }}")).toBe('a@x.io');
  });

  it('gives $now a real Luxon DateTime', async () => {
    expect(await resolveValue(types, '={{ $now.toFormat("yyyy") }}')).toMatch(/^\d{4}$/);
  });

  it('leaves a missing leaf undefined rather than throwing', async () => {
    expect(await resolveValue(types, '={{ $json.body.missing }}')).toBeUndefined();
  });

  /**
   * n8n 2.10.0's evaluator swallows almost every runtime error and yields
   * `undefined`: property access through a missing branch, calling a method on
   * undefined, an unknown identifier, `JSON.parse` of junk, even an explicit
   * `throw` inside the expression. That is *why* the oracle in spec §4 is built
   * on undefined-detection rather than on caught exceptions — silent undefined
   * is the bug class workflow-test exists to catch.
   */
  it.each([
    '={{ $json.body.missing.deep }}',
    '={{ $json.body.missing.toUpperCase() }}',
    '={{ notAVariable }}',
    "={{ JSON.parse('nope') }}",
    '={{ (() => { throw new Error("boom") })() }}',
  ])('resolves %s to undefined rather than throwing', async (expression) => {
    expect(await resolveValue(types, expression)).toBeUndefined();
  });

  it('reports a structural expression error as a ParameterEvaluationError', async () => {
    const expression = "={{ $('NoSuchNode').item.json.x }}";
    await expect(resolveValue(types, expression)).rejects.toBeInstanceOf(ParameterEvaluationError);
    const error = (await resolveValue(types, expression).catch(
      (e: unknown) => e,
    )) as ParameterEvaluationError;
    expect(error.node).toBe('Extract');
    expect(error.parameter).toBe('assignments');
    expect(error.expression).toContain('NoSuchNode');
    expect(error.itemIndex).toBe(0);
  });

  it('fills in parameter defaults from the node description', async () => {
    const node = setNode('={{ $json.body.email }}');
    delete (node.parameters as Record<string, unknown>).mode;
    const wf = buildWorkflow(workflowWith(node), types);
    const runData = new RunData();
    runData.setOutputs('Webhook', [TRIGGER_ITEMS]);
    const resolved = resolveParameters(wf, wf.getNode('Extract') as INode, runData, TRIGGER_ITEMS, 0);
    expect(resolved.mode).toBe('manual');
  });
});

describe('RunData', () => {
  it('exposes n8n-shaped run data that records node outputs', () => {
    const runData = new RunData();
    expect(runData.data.resultData.runData).toEqual({});
    runData.setOutputs('Webhook', [TRIGGER_ITEMS]);
    expect(runData.outputsOf('Webhook')).toEqual([TRIGGER_ITEMS]);
    expect(runData.data.resultData.runData.Webhook?.[0]?.data?.main).toEqual([TRIGGER_ITEMS]);
    expect(runData.outputsOf('Nope')).toBeUndefined();
  });
});
