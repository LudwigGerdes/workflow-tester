/**
 * The one place workflow-test reaches the network.
 *
 * `fetch` is an argument rather than a global so every test runs against a stub
 * and the suite never makes a request. The key travels in a header and appears
 * nowhere else — not in a URL, not in an error — because an error message is
 * the easiest way for a credential to end up in a log.
 */

export interface ExecutionSummary {
  /** A string, not a number: the API returns "7". */
  id: string;
  status: string;
  startedAt: string;
  stoppedAt?: string;
  finished: boolean;
  mode: string;
  workflowId: string;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  active: boolean;
  updatedAt: string;
}

export class InstanceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'InstanceError';
  }
}

export interface InstanceClient {
  getWorkflow(id: string): Promise<unknown>;
  listExecutions(workflowId: string, limit?: number): Promise<ExecutionSummary[]>;
  getExecution(id: string): Promise<unknown>;
}

export interface ClientOptions {
  url: string;
  key: string;
  fetch?: typeof globalThis.fetch;
}

export function createClient(options: ClientOptions): InstanceClient {
  const base = options.url.replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;

  const get = async (path: string): Promise<unknown> => {
    const url = `${base}/api/v1${path}`;
    let response;
    try {
      response = await doFetch(url, { headers: { 'X-N8N-API-KEY': options.key } });
    } catch (error) {
      // The message is the transport's, never the request's: including the
      // request would put the key one refactor away from a log line.
      throw new InstanceError(
        `cannot reach ${base}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw new InstanceError(`${base} answered ${response.status} for ${path}`, response.status);
    }
    return (await response.json()) as unknown;
  };

  return {
    getWorkflow: (id) => get(`/workflows/${encodeURIComponent(id)}`),
    listExecutions: async (workflowId, limit = 10) => {
      const body = (await get(
        `/executions?workflowId=${encodeURIComponent(workflowId)}&limit=${limit}`,
      )) as { data?: unknown[] } | null;
      const rows = body?.data ?? [];
      return rows.filter((row): row is ExecutionSummary => {
        if (typeof row !== 'object' || row === null) return false;
        const { id, workflowId: wf } = row as { id?: unknown; workflowId?: unknown };
        return typeof id === 'string' && typeof wf === 'string';
      });
    },
    // The listing omits node data; only this asks for it.
    getExecution: (id) => get(`/executions/${encodeURIComponent(id)}?includeData=true`),
  };
}
