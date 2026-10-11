import type { INodeExecutionData } from 'n8n-workflow';
import type { Boundary, EngineInput, EngineResult, HttpPlan } from 'workflow-tester-engine';
import { itemsFromReplies, type ServeReply } from './http-replies.js';

/** The mock's `POST /serve`, as much of the admin API as answering a node needs. */
export interface ServeClient {
  serve(req: { method: string; url: string; headers: Record<string, string>; body?: unknown }): Promise<ServeReply>;
}

export interface MockWalk {
  result: EngineResult;
  /** HTTP Request nodes the mock answered, an error answer included. */
  answered: string[];
}

type Planned = Extract<HttpPlan, { requests: unknown }>;

const plannedOf = (boundary: Boundary): Planned | undefined =>
  boundary.request !== undefined && 'requests' in boundary.request ? boundary.request : undefined;

/** The error output of a node that declares one is its last, and at least the second (walk.ts). */
function errorOutputIndex(workflow: EngineInput['workflow'], node: string): number {
  const main = workflow.connections[node]?.['main'] ?? [];
  return Math.max(main.length, 2) - 1;
}

/**
 * Walk, answer the HTTP Request nodes the walk stopped at from the mock, then
 * walk again with those answers standing in. The engine stays synchronous;
 * each node is asked at most once, so the loop ends after one round per node.
 */
export async function walkWithMock(
  input: EngineInput,
  walkOnce: (input: EngineInput) => Promise<EngineResult>,
  mock: ServeClient,
): Promise<MockWalk> {
  const routed: Record<string, INodeExecutionData[][]> = { ...(input.routed ?? {}) };
  const raised: Record<string, string> = { ...(input.raised ?? {}) };
  const answered: string[] = [];
  for (;;) {
    const result = await walkOnce({ ...input, planRequests: true, routed, raised });
    const fresh = result.boundaries.filter((b) => plannedOf(b) !== undefined && !answered.includes(b.node));
    if (fresh.length === 0) return { result, answered };
    for (const boundary of fresh) {
      const plan = plannedOf(boundary);
      if (plan === undefined) continue;
      const replies: ServeReply[] = [];
      for (const r of plan.requests) {
        replies.push(
          await mock.serve({ method: r.method, url: r.url, headers: r.headers, ...(r.body === undefined ? {} : { body: r.body }) }),
        );
      }
      const node = input.workflow.nodes.find((n) => n.name === boundary.node);
      const outcome = itemsFromReplies(
        plan,
        replies,
        node?.onError === undefined ? {} : { onError: node.onError },
        errorOutputIndex(input.workflow, boundary.node),
      );
      if ('raised' in outcome) raised[boundary.node] = outcome.raised;
      else routed[boundary.node] = outcome.routed;
      answered.push(boundary.node);
    }
  }
}
