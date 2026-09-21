import type { EngineResult } from 'workflow-tester-engine';
import type { WorkflowJson } from 'workflow-tester-generator';

/** A node the walk ended at, and the edge that carried items into it. */
export interface Terminus {
  node: string;
  /** Absent for the trigger, which nothing fed. */
  via?: { node: string; output: number };
}

/**
 * Did the walk run this node?
 *
 * Distinct from producing items, and `outputs` already separates them: a node
 * that ran and emitted nothing is present with empty arrays, while a node the
 * walk never got to is absent. A Filter that dropped every item is still where
 * the workflow ended.
 */
const reached = (result: EngineResult, node: string): boolean =>
  result.outputs[node] !== undefined || result.failures.some((f) => f.node === node);

/**
 * Where the walk ended, and how it got there.
 *
 * A terminus is a node that produced items and whose successors produced none.
 * That covers a branch the data never took as well as the end of the graph —
 * both are endings, and an unreached node is simply absent from `outputs`, so
 * there is nothing to subtract.
 */
export function terminiOf(workflow: WorkflowJson, result: EngineResult): Terminus[] {
  /** node -> the predecessor edge that actually carried items into it. */
  const arrivedBy = new Map<string, { node: string; output: number }>();
  /** node -> successors that produced items. */
  const liveSuccessors = new Map<string, number>();

  for (const [from, connection] of Object.entries(workflow.connections)) {
    if (!reached(result, from)) continue;
    (connection.main ?? []).forEach((output, index) => {
      const carried = (result.outputs[from] ?? [])[index] ?? [];
      for (const edge of output ?? []) {
        if (!reached(result, edge.node)) continue;
        liveSuccessors.set(from, (liveSuccessors.get(from) ?? 0) + 1);
        // `via` names the output that actually carried, so an empty branch
        // never claims to be how a node was reached.
        if (carried.length === 0) continue;
        if (!arrivedBy.has(edge.node)) arrivedBy.set(edge.node, { node: from, output: index });
      }
    });
  }

  const termini: Terminus[] = [];
  const candidates = new Set([
    ...Object.keys(result.outputs),
    ...result.failures.map((f) => f.node),
  ]);
  for (const node of candidates) {
    if ((liveSuccessors.get(node) ?? 0) > 0) continue;
    const via = arrivedBy.get(node);
    termini.push(via === undefined ? { node } : { node, via });
  }
  return termini;
}
