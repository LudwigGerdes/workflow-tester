import { describe, expect, it } from 'vitest';
import { createWorkflowRunner, throwaway } from '../src/run-workflow.js';
import { createMockAdmin } from '../src/mock.js';

const workflow = {
  id: 'w1', name: 'Orders', versionId: 'v', meta: { instanceId: 'secret' }, tags: [{ name: 'x' }],
  nodes: [
    { name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, parameters: { path: 'orders', httpMethod: 'POST' }, webhookId: 'orders' },
    { name: 'Fetch', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, parameters: { url: 'https://api.acme.test/x' } },
  ],
  connections: {},
};

describe('throwaway', () => {
  it('renames the copy, gives the webhook a fresh path, and drops instance-owned fields', () => {
    const { workflow: copy, method } = throwaway(workflow, 'Webhook', 'abc-123');
    expect(copy['name']).toBe('workflow-tester Orders abc-123');
    expect(copy).not.toHaveProperty('id');
    expect(copy).not.toHaveProperty('meta');
    expect(copy).not.toHaveProperty('tags');
    const nodes = copy['nodes'] as Array<{ name: string; parameters: Record<string, unknown>; webhookId?: string }>;
    expect(nodes[0]?.parameters['path']).toBe('abc-123');
    expect(nodes[0]?.webhookId).toBe('abc-123');
    expect(nodes[1]?.parameters['url']).toBe('https://api.acme.test/x');
    expect(method).toBe('POST');
  });
});

describe('createWorkflowRunner', () => {
  it('creates, publishes, fires the webhook, waits for the execution, reads it, and deletes the copy', async () => {
    const calls: string[] = [];
    let polls = 0;
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const m = init?.method ?? 'GET';
      calls.push(`${m} ${u.replace('https://n8n.test', '')}`);
      const reply = (body: unknown, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status });
      if (m === 'POST' && u.endsWith('/api/v1/workflows')) {
        expect(init?.headers).toMatchObject({ 'X-N8N-API-KEY': 'key' });
        return reply({ id: 'copy-1' });
      }
      if (u.endsWith('/publish')) return reply(undefined, 204);
      if (u.includes('/webhook/')) {
        expect(JSON.parse(String(init?.body))).toEqual({ record: { name: 9 } });
        return reply({ ok: true });
      }
      if (u.includes('/api/v1/executions?')) return reply({ data: polls++ === 0 ? [] : [{ id: 'ex-7', finished: true, status: 'success' }] });
      if (u.includes('/api/v1/executions/ex-7')) return reply({ id: 'ex-7', status: 'success', data: { resultData: { runData: {} } } });
      if (m === 'DELETE') return reply(undefined, 204);
      return reply({ error: 'unexpected' }, 500);
    }) as typeof globalThis.fetch;

    const runner = createWorkflowRunner({ url: 'https://n8n.test/', key: 'key', fetch, sleep: async () => {} });
    const { execution, id } = await runner.run({ workflow, trigger: 'Webhook', payload: { body: { record: { name: 9 } } } });
    expect(id).toBe('ex-7');
    expect((execution as { status: string }).status).toBe('success');
    expect(calls[0]).toBe('POST /api/v1/workflows');
    expect(calls[1]).toBe('POST /api/v1/workflows/copy-1/publish');
    expect(calls[2]).toMatch(/^POST \/webhook\/[0-9a-f-]{36}$/);
    expect(calls.at(-1)).toBe('DELETE /api/v1/workflows/copy-1');
  });

  it('deletes the copy even when the webhook is not registered', async () => {
    const calls: string[] = [];
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.endsWith('/api/v1/workflows')) return new Response(JSON.stringify({ id: 'c' }), { status: 200 });
      if (u.includes('/webhook/')) return new Response('', { status: 404 });
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;
    const runner = createWorkflowRunner({ url: 'https://n8n.test', key: 'k', fetch, sleep: async () => {} });
    await expect(runner.run({ workflow, trigger: 'Webhook', payload: {} })).rejects.toThrow(/not registered/);
    expect(calls.at(-1)).toMatch(/^DELETE .*\/workflows\/c$/);
  });
});

describe('createMockAdmin', () => {
  it('speaks the admin API and reads the log as calls', async () => {
    const seen: string[] = [];
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      seen.push(`${init?.method} ${String(url)} ${init?.body ?? ''} ${(init?.headers as Record<string, string>)['authorization'] ?? ''}`);
      if (String(url).includes('/log')) return new Response(JSON.stringify([{ ts: 5, service: 'acme', method: 'GET', path: '/x', status: 200, matchedRoute: 'r' }]), { status: 200 });
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;
    const admin = createMockAdmin({ url: 'http://127.0.0.1:8081/', token: 't', fetch });
    await admin.enablePacks(['acme']);
    await admin.setFault('acme', { status: 503 });
    await admin.clearFaults();
    await admin.resetStores();
    expect(await admin.log(3)).toEqual([{ ts: 5, service: 'acme', method: 'GET', path: '/x', status: 200, matchedRoute: 'r' }]);
    expect(seen).toEqual([
      'PUT http://127.0.0.1:8081/packs/enabled {"ids":["acme"]} Bearer t',
      'PUT http://127.0.0.1:8081/faults/acme {"status":503} Bearer t',
      'DELETE http://127.0.0.1:8081/faults  Bearer t',
      'POST http://127.0.0.1:8081/packs/reset  Bearer t',
      'GET http://127.0.0.1:8081/log?since=3  Bearer t',
    ]);
  });
});
