/**
 * integration-mock's admin API, as much of it as a live run needs. The
 * daemon writes its admin port (and a token when bound off loopback) to
 * `~/.integration-mock/proxy.json`; the CLI reads those and hands them here.
 */
export interface MockCall {
  ts: number;
  service: string;
  method: string;
  path: string;
  status: number;
  matchedRoute: string;
}

export interface MockAdmin {
  enablePacks(ids: string[]): Promise<void>;
  setFault(service: string, spec: unknown): Promise<void>;
  clearFaults(): Promise<void>;
  resetStores(): Promise<void>;
  log(since: number): Promise<MockCall[]>;
}

export interface MockAdminOptions {
  /** e.g. `http://127.0.0.1:8081` */
  url: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export class MockError extends Error {}

export function createMockAdmin(options: MockAdminOptions): MockAdmin {
  const base = options.url.replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (error) {
      throw new MockError(`cannot reach integration-mock at ${base}: ${error instanceof Error ? error.message : String(error)} — is it started?`);
    }
    if (!response.ok) throw new MockError(`integration-mock ${method} ${path} answered ${response.status}`);
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  };
  return {
    enablePacks: (ids) => call('PUT', '/packs/enabled', { ids }),
    setFault: (service, spec) => call('PUT', `/faults/${encodeURIComponent(service)}`, spec),
    clearFaults: () => call('DELETE', '/faults'),
    resetStores: () => call('POST', '/packs/reset'),
    log: async (since) => {
      const rows = await call<Array<Record<string, unknown>>>('GET', `/log?since=${since}`);
      return rows.map((r) => ({
        ts: Number(r['ts'] ?? 0),
        service: String(r['service'] ?? ''),
        method: String(r['method'] ?? ''),
        path: String(r['path'] ?? ''),
        status: Number(r['status'] ?? 0),
        matchedRoute: String(r['matchedRoute'] ?? ''),
      }));
    },
  };
}
