import { describe, expect, it } from 'vitest';
import { walkWith } from '../src/walk.js';
import type { WorkflowJson } from '../src/types.js';

/** Webhook → HTTP (an HTTP Request node) → Ok on output 0, Failed on output 1. */
const workflow = (onError?: 'continueErrorOutput'): WorkflowJson => ({
  nodes: [
    { id: 'wh', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: 'x', httpMethod: 'POST' } },
    {
      id: 'http',
      name: 'HTTP',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1, 0],
      ...(onError === undefined ? {} : { onError }),
      parameters: { method: 'GET', url: 'https://api.acme.com/v1/orders', options: {} },
    },
    { id: 'ok', name: 'Ok', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [2, 0], parameters: {} },
    { id: 'failed', name: 'Failed', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [2, 1], parameters: {} },
  ],
  connections: {
    Webhook: { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] },
    HTTP: { main: [[{ node: 'Ok', type: 'main', index: 0 }], [{ node: 'Failed', type: 'main', index: 0 }]] },
  },
});

describe('stand-ins beyond the first output', () => {
  it('routes a multi-output stand-in to the outputs it names', async () => {
    const result = await walkWith({
      workflow: workflow('continueErrorOutput'),
      trigger: 'Webhook',
      payload: { body: {} },
      routed: { HTTP: [[], [{ json: { error: 'the mock answered 503' } }]] },
    });
    expect(result.outputs['Failed']?.[0]?.map((item) => item.json)).toEqual([{ error: 'the mock answered 503' }]);
    expect(result.reachedNodes).not.toContain('Ok');
    expect(result.substituted).toContain('HTTP');
    expect(result.boundaries).toEqual([]);
    // Same record the engine keeps when it routes a throw itself.
    expect(result.errorOutputs).toEqual(['HTTP']);
  });

  it('a routed answer on the regular output only is not an error path', async () => {
    const result = await walkWith({
      workflow: workflow('continueErrorOutput'),
      trigger: 'Webhook',
      payload: { body: {} },
      routed: { HTTP: [[{ json: { ok: true } }], []] },
    });
    expect(result.errorOutputs).toEqual([]);
  });

  it('a raised node error fails the run at that node', async () => {
    const result = await walkWith({
      workflow: workflow(),
      trigger: 'Webhook',
      payload: { body: {} },
      raised: { HTTP: 'the mock answered 503' },
    });
    expect(result.status).toBe('fail');
    expect(result.failures[0]).toMatchObject({ kind: 'node-error', node: 'HTTP', message: 'the mock answered 503' });
    expect(result.reachedNodes).not.toContain('Ok');
  });
});

describe('request plans at an HTTP Request boundary', () => {
  const planned = (): WorkflowJson => {
    const wf = workflow();
    const http = wf.nodes.find((n) => n.name === 'HTTP')!;
    http.parameters = { method: 'GET', url: '={{ "https://api.acme.com/v1/orders/" + $json.body.id }}', options: {} };
    return wf;
  };

  it('with planRequests, the boundary carries the requests per input item', async () => {
    const result = await walkWith({ workflow: planned(), trigger: 'Webhook', payload: { body: { id: 'o_1' } }, planRequests: true });
    expect(result.boundaries[0]!.request).toMatchObject({
      requests: [{ itemIndex: 0, method: 'GET', url: 'https://api.acme.com/v1/orders/o_1' }],
    });
  });

  it('without it, the boundary is as before', async () => {
    const result = await walkWith({ workflow: planned(), trigger: 'Webhook', payload: { body: { id: 'o_1' } } });
    expect(result.boundaries[0]!.request).toBeUndefined();
  });
});

describe('request plans: retry on fail', () => {
  it('an HTTP Request node with Retry On Fail is not answered offline', async () => {
    const wf = workflow();
    const http = wf.nodes.find((n) => n.name === 'HTTP')!;
    http.retryOnFail = true;
    const result = await walkWith({ workflow: wf, trigger: 'Webhook', payload: { body: {} }, planRequests: true });
    expect(result.boundaries[0]!.request).toEqual({ unsupported: 'retry on fail is not answered offline' });
  });
});
