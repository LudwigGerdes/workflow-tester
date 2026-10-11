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
  clearSnapshot(): Promise<void>;
  activateSnapshot(snapshot: unknown): Promise<void>;
  seedStore(service: string, seed: Record<string, unknown[]>): Promise<void>;
  /** Answer one request without passing it through (`POST /serve`, integration-mock 0.4.0). */
  serve(req: { method: string; url: string; headers: Record<string, string>; body?: unknown }): Promise<ServeReply>;
  log(since: number): Promise<MockCall[]>;
}

export interface ServeReply {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockAdminOptions {
  /** e.g. `http://127.0.0.1:8081` */
  url: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export class MockError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The mock's own `error` text, when it sent one. */
    readonly detail?: string,
  ) {
    super(message);
  }
}

/** integration-mock answers an admin path it does not have with this; an older release lacks the newer endpoints. */
const isMissingEndpoint = (error: unknown): boolean =>
  error instanceof MockError && error.status === 404 && error.detail === 'not found';

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
    if (!response.ok) {
      const detail = await response.json().then(
        (b: unknown) => (b !== null && typeof b === 'object' && 'error' in b && typeof b.error === 'string' ? b.error : undefined),
        () => undefined,
      );
      throw new MockError(
        `integration-mock ${method} ${path} answered ${response.status}${detail === undefined ? '' : `: ${detail}`}`,
        response.status,
        detail,
      );
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  };
  return {
    enablePacks: (ids) => call('PUT', '/packs/enabled', { ids }),
    setFault: (service, spec) => call('PUT', `/faults/${encodeURIComponent(service)}`, spec),
    clearFaults: () => call('DELETE', '/faults'),
    resetStores: () => call('POST', '/packs/reset'),
    clearSnapshot: () => call('DELETE', '/snapshot'),
    activateSnapshot: (snapshot) => call('PUT', '/snapshot', snapshot),
    seedStore: async (service, seed) => {
      try {
        await call('PUT', `/stores/${encodeURIComponent(service)}`, seed);
      } catch (error) {
        if (isMissingEndpoint(error)) {
          throw new MockError('this integration-mock does not accept given.seed; it needs 0.4.0 or later', 404);
        }
        if (error instanceof MockError && error.detail !== undefined) throw new MockError(error.detail, error.status, error.detail);
        throw error;
      }
    },
    serve: async (req) => {
      try {
        return await call<ServeReply>('POST', '/serve', req);
      } catch (error) {
        if (isMissingEndpoint(error)) throw new MockError('run --mock needs integration-mock 0.4.0 or later', 404);
        throw error;
      }
    },
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
