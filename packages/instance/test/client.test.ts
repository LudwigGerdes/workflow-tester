import { describe, expect, it } from 'vitest';
import { createClient, InstanceError } from '../src/client.js';

/** A fetch that answers from a table, and records what it was asked. */
const stub = (table: Record<string, { status?: number; body: unknown }>) => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchStub = (async (input: string | URL, init?: { headers?: Record<string, string> }) => {
    const url = String(input);
    seen.push({ url, headers: init?.headers ?? {} });
    const match = Object.keys(table).find((k) => url.includes(k));
    const entry = match === undefined ? undefined : table[match];
    if (entry === undefined) return { ok: false, status: 404, json: async () => ({}) };
    const status = entry.status ?? 200;
    return { ok: status < 400, status, json: async () => entry.body };
  }) as unknown as typeof globalThis.fetch;
  return { fetchStub, seen };
};

const EXECUTION_LIST = {
  data: [
    {
      id: '7',
      status: 'success',
      startedAt: '2026-09-07T20:37:47.222Z',
      stoppedAt: '2026-09-07T20:37:47.300Z',
      finished: true,
      mode: 'webhook',
      workflowId: 'W1',
    },
    {
      id: '6',
      status: 'error',
      startedAt: '2026-09-07T19:00:00.000Z',
      finished: false,
      mode: 'webhook',
      workflowId: 'W1',
    },
  ],
  nextCursor: null,
};

describe('createClient', () => {
  it('sends the key as a header and nowhere else', async () => {
    const { fetchStub, seen } = stub({ '/workflows/W1': { body: { id: 'W1' } } });
    const client = createClient({ url: 'https://n8n.example', key: 'secret-key', fetch: fetchStub });
    await client.getWorkflow('W1');
    expect(seen[0]?.headers['X-N8N-API-KEY']).toBe('secret-key');
    expect(seen[0]?.url).not.toContain('secret-key');
  });

  it('fetches a workflow by id', async () => {
    const { fetchStub, seen } = stub({ '/workflows/W1': { body: { id: 'W1', name: 'invoice' } } });
    const client = createClient({ url: 'https://n8n.example', key: 'k', fetch: fetchStub });
    expect(await client.getWorkflow('W1')).toEqual({ id: 'W1', name: 'invoice' });
    expect(seen[0]?.url).toBe('https://n8n.example/api/v1/workflows/W1');
  });

  it('lists executions for one workflow, newest first as the API returns them', async () => {
    const { fetchStub, seen } = stub({ '/executions?': { body: EXECUTION_LIST } });
    const client = createClient({ url: 'https://n8n.example', key: 'k', fetch: fetchStub });
    const list = await client.listExecutions('W1', 5);
    expect(list.map((e) => e.id)).toEqual(['7', '6']);
    expect(list[0]?.startedAt).toBe('2026-09-07T20:37:47.222Z');
    expect(seen[0]?.url).toContain('workflowId=W1');
    expect(seen[0]?.url).toContain('limit=5');
  });

  it('asks for the data only when fetching one execution', async () => {
    const { fetchStub, seen } = stub({
      '/executions/7': { body: { id: '7', data: { resultData: { runData: {} } } } },
    });
    const client = createClient({ url: 'https://n8n.example', key: 'k', fetch: fetchStub });
    await client.getExecution('7');
    expect(seen[0]?.url).toBe('https://n8n.example/api/v1/executions/7?includeData=true');
  });

  it('trims a trailing slash off the base url', async () => {
    const { fetchStub, seen } = stub({ '/workflows/W1': { body: {} } });
    const client = createClient({ url: 'https://n8n.example/', key: 'k', fetch: fetchStub });
    await client.getWorkflow('W1');
    expect(seen[0]?.url).toBe('https://n8n.example/api/v1/workflows/W1');
  });

  it('raises a typed error on an unauthorised response, without the key in it', async () => {
    const { fetchStub } = stub({
      '/workflows/W1': { status: 401, body: { message: 'unauthorized' } },
    });
    const client = createClient({ url: 'https://n8n.example', key: 'secret-key', fetch: fetchStub });
    await expect(client.getWorkflow('W1')).rejects.toBeInstanceOf(InstanceError);
    await expect(client.getWorkflow('W1')).rejects.toThrow(/401/);
    await expect(client.getWorkflow('W1')).rejects.not.toThrow(/secret-key/);
  });

  it('raises a typed error when the instance cannot be reached', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const client = createClient({ url: 'https://n8n.example', key: 'k', fetch: failing });
    await expect(client.getWorkflow('W1')).rejects.toBeInstanceOf(InstanceError);
    await expect(client.getWorkflow('W1')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('returns an empty list rather than throwing when a workflow has never run', async () => {
    const { fetchStub } = stub({ '/executions?': { body: { data: [], nextCursor: null } } });
    const client = createClient({ url: 'https://n8n.example', key: 'k', fetch: fetchStub });
    expect(await client.listExecutions('W1')).toEqual([]);
  });
});
