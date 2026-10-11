import { describe, expect, it } from 'vitest';
import { createMockAdmin } from '../src/mock.js';

const answering = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

describe('createMockAdmin', () => {
  it('seedStore on an integration-mock without the endpoint names the version it needs', async () => {
    const admin = createMockAdmin({ url: 'http://m', fetch: answering(404, { error: 'not found' }) });
    await expect(admin.seedStore('acme', {})).rejects.toThrow('this integration-mock does not accept given.seed; it needs 0.4.0 or later');
  });

  it("seedStore for a service no pack provides passes the mock's message on", async () => {
    const admin = createMockAdmin({ url: 'http://m', fetch: answering(404, { error: 'no pack provides "acme"' }) });
    await expect(admin.seedStore('acme', {})).rejects.toThrow('no pack provides "acme"');
  });

  it('serve on an older integration-mock names the version --mock needs', async () => {
    const admin = createMockAdmin({ url: 'http://m', fetch: answering(404, { error: 'not found' }) });
    await expect(admin.serve({ method: 'GET', url: 'https://x.io', headers: {} })).rejects.toThrow('run --mock needs integration-mock 0.4.0 or later');
  });

  it('serve, snapshot and seed go to the endpoints the mock exposes', async () => {
    const seen: string[] = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(`${init?.method} ${String(url)} ${init?.body ?? ''}`);
      return url.toString().endsWith('/serve')
        ? new Response(JSON.stringify({ status: 200, headers: {}, body: { ok: true } }), { status: 200 })
        : new Response(null, { status: 204 });
    };
    const admin = createMockAdmin({ url: 'http://m/', fetch });
    await admin.clearSnapshot();
    await admin.activateSnapshot({ packs: [] });
    await admin.seedStore('acme', { things: [] });
    expect(await admin.serve({ method: 'GET', url: 'https://x.io', headers: {} })).toEqual({ status: 200, headers: {}, body: { ok: true } });
    expect(seen).toEqual([
      'DELETE http://m/snapshot ',
      'PUT http://m/snapshot {"packs":[]}',
      'PUT http://m/stores/acme {"things":[]}',
      'POST http://m/serve {"method":"GET","url":"https://x.io","headers":{}}',
    ]);
  });
});
