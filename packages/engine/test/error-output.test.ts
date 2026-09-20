import { describe, expect, it } from 'vitest';
import { walkWith } from '../src/walk.js';
import type { WorkflowJson } from '../src/types.js';

const workflow = (explode: boolean): WorkflowJson => ({
  nodes: [
    {
      id: 'wh1',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 0],
      parameters: { path: 'x', httpMethod: 'POST' },
    },
    {
      id: 'code1',
      name: 'Risky',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1, 0],
      onError: 'continueErrorOutput',
      parameters: {
        jsCode: explode ? "throw new Error('boom');" : 'return [{ json: { ok: true } }];',
      },
    },
  ],
  connections: { Webhook: { main: [[{ node: 'Risky', type: 'main', index: 0 }]] } },
});

describe('error outputs', () => {
  it('routes a throw to the last output instead of failing the run', async () => {
    const result = await walkWith({
      workflow: workflow(true),
      trigger: 'Webhook',
      payload: { body: {} },
    });
    expect(result.failures).toEqual([]);
    expect(result.errorOutputs).toEqual(['Risky']);
    const outputs = result.outputs['Risky'];
    expect(outputs?.[0]).toEqual([]);
    expect(outputs?.[1]).toHaveLength(1);
    expect((outputs?.[1]?.[0]?.json as { error?: string }).error).toContain('boom');
  });

  it('leaves the success output carrying when nothing threw', async () => {
    const result = await walkWith({
      workflow: workflow(false),
      trigger: 'Webhook',
      payload: { body: {} },
    });
    expect(result.errorOutputs).toEqual([]);
    expect(result.outputs['Risky']?.[0]).toHaveLength(1);
  });

  it('still fails when the node has no error output configured', async () => {
    const bare = workflow(true);
    const risky = bare.nodes[1];
    if (risky !== undefined) delete risky.onError;
    const result = await walkWith({ workflow: bare, trigger: 'Webhook', payload: { body: {} } });
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.errorOutputs).toEqual([]);
  });
});

describe('Stop and Error', () => {
  it('fails the run with a kind that says the stop was deliberate', async () => {
    const result = await walkWith({
      workflow: {
        nodes: [
          {
            id: 'wh1',
            name: 'Webhook',
            type: 'n8n-nodes-base.webhook',
            typeVersion: 2,
            position: [0, 0],
            parameters: { path: 'x', httpMethod: 'POST' },
          },
          {
            id: 'stop1',
            name: 'Reject',
            type: 'n8n-nodes-base.stopAndError',
            typeVersion: 1,
            position: [1, 0],
            parameters: { errorMessage: 'order rejected' },
          },
        ],
        connections: { Webhook: { main: [[{ node: 'Reject', type: 'main', index: 0 }]] } },
      },
      trigger: 'Webhook',
      payload: { body: {} },
    });
    const [failure] = result.failures;
    expect(failure?.kind).toBe('deliberate-stop');
    expect(failure?.node).toBe('Reject');
    expect(failure?.message).toContain('order rejected');
    expect(result.outputs['Reject']).toBeUndefined();
  });
});
