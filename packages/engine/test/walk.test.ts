import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { walk } from '../src/walk.js';
import { loadNodeTypes, type NodeTypeSource } from '../src/node-types.js';
import type { WorkflowJson } from '../src/types.js';

const fixture = (name: string): WorkflowJson =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/workflows/${name}.json`, import.meta.url)), 'utf8'),
  ) as WorkflowJson;

/** What a Webhook node hands downstream. */
const envelope = (body: unknown) => ({ headers: {}, params: {}, query: {}, body });

describe('walk', () => {
  let types: NodeTypeSource;
  beforeAll(async () => {
    types = await loadNodeTypes();
  });

  it('runs a fully pure workflow to the end', () => {
    const result = walk(
      { workflow: fixture('linear'), trigger: 'Webhook', payload: envelope({ email: 'a@x.io' }) },
      types,
    );
    expect(result.status).toBe('pass');
    expect(result.reachedNodes).toEqual(['Webhook', 'Extract', 'Has Email?', 'Yes']);
    expect(result.outputs['Has Email?']?.[0]).toHaveLength(1);
    expect(result.outputs.Extract?.[0]?.[0]?.json).toEqual({ email: 'a@x.io' });
    expect(result.failures).toEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('routes down the other branch and warns when a value goes missing', () => {
    const result = walk(
      { workflow: fixture('linear'), trigger: 'Webhook', payload: envelope({}) },
      types,
    );
    expect(result.status).toBe('pass');
    expect(result.reachedNodes).toEqual(['Webhook', 'Extract', 'Has Email?', 'No']);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ kind: 'optional-undefined', node: 'Extract', parameter: 'assignments.email' }),
    );
  });

  it('stops at a non-pure node and reports it as a boundary, not a failure', () => {
    const result = walk(
      { workflow: fixture('boundary'), trigger: 'Webhook', payload: envelope({ email: 'a@x.io' }) },
      types,
    );
    expect(result.status).toBe('boundary');
    expect(result.failures).toEqual([]);
    expect(result.boundaries).toHaveLength(1);
    const [boundary] = result.boundaries;
    expect(boundary?.node).toBe('Call API');
    expect(boundary?.type).toBe('n8n-nodes-base.httpRequest');
    expect(boundary?.reason).toBe('not-pure');
    expect(boundary?.inputItems).toEqual(result.outputs.Prepare?.[0]);
    expect(result.reachedNodes).not.toContain('After');
  });

  it('fails when a condition cannot be decided', () => {
    const result = walk(
      { workflow: fixture('strict-if'), trigger: 'Webhook', payload: envelope({}) },
      types,
    );
    expect(result.status).toBe('fail');
    expect(result.failures).toContainEqual(
      expect.objectContaining({ kind: 'condition-undefined', node: 'Big?', parameter: 'conditions', itemIndex: 0 }),
    );
    expect(result.reachedNodes).not.toContain('Big');
    expect(result.reachedNodes).not.toContain('Small');
  });

  it('names the expression and the path that resolved to nothing', () => {
    const result = walk(
      { workflow: fixture('strict-if'), trigger: 'Webhook', payload: envelope({}) },
      types,
    );
    const [failure] = result.failures;
    expect(failure?.expression).toBe('={{ $json.body.amount }}');
    // this is what makes a report actionable rather than merely correct
    expect(failure?.resolvedPath).toBe('body.amount → undefined');
  });

  it('decides the condition normally when the value is there', () => {
    const result = walk(
      { workflow: fixture('strict-if'), trigger: 'Webhook', payload: envelope({ amount: 500 }) },
      types,
    );
    expect(result.status).toBe('pass');
    expect(result.reachedNodes).toEqual(['Webhook', 'Big?', 'Big']);
  });

  it('fails on a structural expression error, naming node and parameter', () => {
    const result = walk(
      { workflow: fixture('bad-ref'), trigger: 'Webhook', payload: envelope({}) },
      types,
    );
    expect(result.status).toBe('fail');
    expect(result.failures).toContainEqual(
      expect.objectContaining({ kind: 'expression-error', node: 'Broken', parameter: 'assignments' }),
    );
    expect(result.failures[0]?.expression).toContain('NoSuchNode');
  });

  it('warns about a dead branch when items reach an unconnected output', () => {
    const json = fixture('linear');
    // drop the false branch: items routed there have nowhere to go
    json.connections['Has Email?'] = { main: [[{ node: 'Yes', type: 'main', index: 0 }]] };
    const result = walk({ workflow: json, trigger: 'Webhook', payload: envelope({}) }, types);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ kind: 'dead-branch', node: 'Has Email?', output: 1 }),
    );
  });

  it('treats an unknown node type as a boundary rather than throwing', () => {
    const json = fixture('linear');
    json.nodes.push({
      parameters: {},
      id: 'x',
      name: 'Community Thing',
      type: 'n8n-nodes-community.whatever',
      typeVersion: 1,
      position: [880, 0],
    });
    json.connections.Yes = { main: [[{ node: 'Community Thing', type: 'main', index: 0 }]] };
    const result = walk(
      { workflow: json, trigger: 'Webhook', payload: envelope({ email: 'a@x.io' }) },
      types,
    );
    expect(result.status).toBe('boundary');
    expect(result.boundaries[0]?.node).toBe('Community Thing');
    expect(result.boundaries[0]?.reason).toBe('not-pure');
  });

  it('marks a pure type at an unsupported version as unsupported-mode', () => {
    const json = fixture('linear');
    const extract = json.nodes.find((n) => n.name === 'Extract');
    if (extract) extract.typeVersion = 2;
    const result = walk(
      { workflow: json, trigger: 'Webhook', payload: envelope({ email: 'a@x.io' }) },
      types,
    );
    expect(result.status).toBe('boundary');
    expect(result.boundaries[0]).toEqual(
      expect.objectContaining({ node: 'Extract', reason: 'unsupported-mode' }),
    );
  });
});

describe('walk termination', () => {
  let types: NodeTypeSource;
  beforeAll(async () => {
    types = await loadNodeTypes();
  });

  it('terminates on a cyclic workflow instead of deferring forever', () => {
    // A -> B -> A. Both nodes wait on a predecessor that is itself queued.
    const json: WorkflowJson = {
      id: 'cycle',
      name: 'cycle',
      nodes: [
        { parameters: { httpMethod: 'POST', path: 'c', options: {} }, id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0] },
        { parameters: {}, id: 'n2', name: 'A', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [220, 0] },
        { parameters: {}, id: 'n3', name: 'B', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [440, 0] },
      ],
      connections: {
        Webhook: { main: [[{ node: 'A', type: 'main', index: 0 }]] },
        A: { main: [[{ node: 'B', type: 'main', index: 0 }]] },
        B: { main: [[{ node: 'A', type: 'main', index: 0 }]] },
      },
    };
    const result = walk({ workflow: json, trigger: 'Webhook', payload: envelope({}) }, types);
    expect(result.reachedNodes).toContain('A');
    expect(result.reachedNodes).toContain('B');
    // each node settles exactly once
    expect(new Set(result.reachedNodes).size).toBe(result.reachedNodes.length);
  });

  it('does not spin when two queued nodes each wait on the other', () => {
    const json: WorkflowJson = {
      id: 'm',
      name: 'm',
      nodes: [
        { parameters: { httpMethod: 'POST', path: 'm', options: {} }, id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0] },
        { parameters: {}, id: 'n2', name: 'A', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [220, -50] },
        { parameters: {}, id: 'n3', name: 'B', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [220, 50] },
      ],
      // Webhook fans out to A and B, so both enter the queue together; A also
      // takes input from B and B from A. Without a deferral bound this spins
      // forever, which no timeout in a worker would rescue.
      connections: {
        Webhook: { main: [[{ node: 'A', type: 'main', index: 0 }, { node: 'B', type: 'main', index: 0 }]] },
        A: { main: [[{ node: 'B', type: 'main', index: 0 }]] },
        B: { main: [[{ node: 'A', type: 'main', index: 0 }]] },
      },
    };
    const result = walk({ workflow: json, trigger: 'Webhook', payload: envelope({}) }, types);
    expect(result.reachedNodes).toContain('A');
    expect(result.reachedNodes).toContain('B');
    expect(new Set(result.reachedNodes).size).toBe(result.reachedNodes.length);
  });

  it('runs a Code node through the real data proxy and carries its output on', () => {
    const result = walk(
      { workflow: fixture('code-pure'), trigger: 'Webhook', payload: envelope({ name: 'ada' }) },
      types,
    );
    expect(result.status).toBe('pass');
    expect(result.reachedNodes).toEqual(['Webhook', 'Shout', 'Greet']);
    expect(result.outputs.Shout?.[0]?.[0]?.json).toEqual({ shouted: 'ADA' });
    // The downstream expression reads what the Code node produced, which is the
    // whole point: a shape change here would surface as a failure there.
    expect(result.outputs.Greet?.[0]?.[0]?.json).toEqual({ greeting: 'hi ADA' });
  });

  it('ends the path at an impure call and names it', () => {
    const result = walk(
      { workflow: fixture('code-impure'), trigger: 'Webhook', payload: envelope({ a: 1 }) },
      types,
    );
    expect(result.status).toBe('boundary');
    expect(result.failures).toEqual([]);
    const [boundary] = result.boundaries;
    expect(boundary?.node).toBe('Fetch In Code');
    expect(boundary?.reason).toBe('impure-call');
    expect(boundary?.call).toBe('$helpers.httpRequest');
    // Everything before the call is still verified; only what follows is not.
    expect(result.reachedNodes).not.toContain('After');
  });
});
