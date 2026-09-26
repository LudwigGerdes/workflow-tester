/**
 * Run a workflow once on an n8n instance and hand back the execution.
 *
 * The public API has no run/execute endpoint, so the loop is: create a copy
 * of the workflow under a throwaway name with a unique webhook path, publish
 * it, POST the payload to its production webhook, wait for the execution to
 * appear, read it with its data, delete the copy. The instance is expected to
 * reach integration-mock already — proxy mode through the environment, or
 * URLs swapped with `integration-mock creds swap` — this module changes no
 * node but the trigger's path.
 */
import { randomUUID } from 'node:crypto';
import { InstanceError } from './client.js';

export interface WorkflowRunner {
  run(input: { workflow: unknown; trigger: string; payload: unknown }): Promise<{ execution: unknown; id?: string }>;
}

export interface RunnerOptions {
  url: string;
  key: string;
  fetch?: typeof globalThis.fetch;
  /** How long to wait for the execution to be recorded. Default 30 s. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface Node {
  name?: string;
  type?: string;
  parameters?: Record<string, unknown>;
  webhookId?: string;
}

const WEBHOOK = 'n8n-nodes-base.webhook';

/** The copy that runs: a fresh name and, for a Webhook trigger, a path of its own. */
export function throwaway(workflow: unknown, trigger: string, path: string): { workflow: Record<string, unknown>; method: string } {
  const wf = { ...(workflow as Record<string, unknown>) };
  const nodes = (Array.isArray(wf['nodes']) ? (wf['nodes'] as Node[]) : []).map((node) => {
    if (node.name !== trigger || node.type !== WEBHOOK) return node;
    return { ...node, webhookId: path, parameters: { ...(node.parameters ?? {}), path } };
  });
  const triggerNode = nodes.find((n) => n.name === trigger);
  const method = String(triggerNode?.parameters?.['httpMethod'] ?? 'POST').toUpperCase();
  // Only what the API accepts on create: id, tags and pin data are the instance's to assign.
  const { id: _id, tags: _tags, pinData: _pin, versionId: _v, meta: _meta, active: _active, ...rest } = wf;
  return { workflow: { ...rest, name: `workflow-tester ${String(wf['name'] ?? 'workflow')} ${path.slice(0, 8)}`, nodes, settings: wf['settings'] ?? {} }, method };
}

export function createWorkflowRunner(options: RunnerOptions): WorkflowRunner {
  const base = options.url.replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = options.timeoutMs ?? 30_000;

  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await doFetch(`${base}/api/v1${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'X-N8N-API-KEY': options.key },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new InstanceError(`cannot reach ${base}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new InstanceError(`${base} answered ${response.status} for ${method} ${path}`, response.status);
    const text = await response.text();
    return (text === '' ? undefined : JSON.parse(text)) as T;
  };

  return {
    async run({ workflow, trigger, payload }) {
      const path = randomUUID();
      const { workflow: copy, method } = throwaway(workflow, trigger, path);
      const created = await api<{ id: string }>('POST', '/workflows', copy);
      try {
        await api('POST', `/workflows/${created.id}/publish`, {});
        const body = payload !== null && typeof payload === 'object' && 'body' in (payload as object) ? (payload as { body: unknown }).body : payload;
        const fired = await doFetch(`${base}/webhook/${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body ?? {}),
        });
        if (fired.status === 404) throw new InstanceError(`the webhook ${path} was not registered; is the workflow's trigger "${trigger}" a Webhook node?`);

        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const list = await api<{ data?: Array<{ id: string; finished?: boolean; status?: string }> }>('GET', `/executions?workflowId=${created.id}&limit=1`);
          const latest = list.data?.[0];
          if (latest !== undefined && (latest.finished === true || (latest.status !== undefined && latest.status !== 'running' && latest.status !== 'waiting'))) {
            const execution = await api<unknown>('GET', `/executions/${latest.id}?includeData=true`);
            return { execution, id: latest.id };
          }
          if (Date.now() > deadline) throw new InstanceError(`no finished execution of the copy after ${timeoutMs} ms`);
          await sleep(250);
        }
      } finally {
        await api('DELETE', `/workflows/${created.id}`).catch(() => undefined);
      }
    },
  };
}
