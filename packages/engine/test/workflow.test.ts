import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { INode } from 'n8n-workflow';
import { buildWorkflow, nodeType, predecessors, successors } from '../src/workflow.js';
import { loadNodeTypes, type NodeTypeSource } from '../src/node-types.js';
import type { WorkflowJson } from '../src/types.js';

const fixture = (name: string): WorkflowJson =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/workflows/${name}.json`, import.meta.url)), 'utf8'),
  ) as WorkflowJson;

describe('buildWorkflow', () => {
  let types: NodeTypeSource;
  beforeAll(async () => {
    types = await loadNodeTypes();
  });

  it('builds an n8n Workflow from workflow JSON', () => {
    const wf = buildWorkflow(fixture('linear'), types);
    expect(wf.getNode('Extract')).not.toBeNull();
    expect(wf.getNode('Has Email?')).not.toBeNull();
  });

  it('reads the trigger and branch structure through successors', () => {
    const wf = buildWorkflow(fixture('linear'), types);
    expect(successors(wf, 'Webhook')).toEqual([{ node: 'Extract', output: 0, input: 0 }]);
    const branches = successors(wf, 'Has Email?');
    expect(branches).toEqual([
      { node: 'Yes', output: 0, input: 0 },
      { node: 'No', output: 1, input: 0 },
    ]);
  });

  it('returns no successors for a terminal node', () => {
    const wf = buildWorkflow(fixture('linear'), types);
    expect(successors(wf, 'Yes')).toEqual([]);
  });

  it('walks backwards through predecessors', () => {
    const wf = buildWorkflow(fixture('linear'), types);
    expect(predecessors(wf, 'Has Email?')).toEqual([{ node: 'Extract', output: 0, input: 0 }]);
    expect(predecessors(wf, 'Webhook')).toEqual([]);
  });

  it('describes a node through the bundle', () => {
    const wf = buildWorkflow(fixture('linear'), types);
    const set = wf.getNode('Extract') as INode;
    expect(nodeType(wf, set)?.name).toBe('n8n-nodes-base.set');
  });

  it('returns undefined for an unknown node type instead of throwing', () => {
    const json = fixture('linear');
    json.nodes.push({
      parameters: {},
      id: 'aaaa',
      name: 'Mystery',
      type: 'n8n-nodes-custom.doesNotExist',
      typeVersion: 1,
      position: [0, 300],
    } as INode);
    const wf = buildWorkflow(json, types);
    const mystery = wf.getNode('Mystery') as INode;
    expect(() => nodeType(wf, mystery)).not.toThrow();
    expect(nodeType(wf, mystery)).toBeUndefined();
  });
});
