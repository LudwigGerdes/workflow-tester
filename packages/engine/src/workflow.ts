import type { INode, INodeTypeDescription, IWorkflowSettings, Workflow } from 'n8n-workflow';
// Values come from the loader shim, types straight from the package: the two
// cannot share an identifier, so the constructor is aliased.
import { Workflow as WorkflowCtor } from './n8n.js';
import type { NodeTypeSource } from './node-types.js';
import type { WorkflowJson } from './types.js';

/** One main-connection edge, as the walker consumes it. */
export interface Edge {
  node: string;
  /** Output index on the *source* node. */
  output: number;
  /** Input index on the *destination* node. */
  input: number;
}

/**
 * Build n8n's own `Workflow` around the JSON. Doing this — rather than reading
 * `node.parameters` directly — is what makes `$('Node').params`, version-specific
 * properties and parameter defaults exact.
 */
export function buildWorkflow(json: WorkflowJson, nodeTypes: NodeTypeSource): Workflow {
  return new WorkflowCtor({
    id: json.id ?? 'payload-contract',
    name: json.name ?? '',
    nodes: json.nodes,
    connections: json.connections,
    active: false,
    nodeTypes,
    settings: (json.settings ?? {}) as IWorkflowSettings,
  });
}

/** Main-type edges leaving `name`, in output order then connection order. */
export function successors(wf: Workflow, name: string): Edge[] {
  const outputs = wf.connectionsBySourceNode[name]?.main ?? [];
  return outputs.flatMap((connections, output) =>
    (connections ?? []).map((c) => ({ node: c.node, output, input: c.index })),
  );
}

/** Main-type edges arriving at `name`, in input order then connection order. */
export function predecessors(wf: Workflow, name: string): Edge[] {
  const inputs = wf.connectionsByDestinationNode[name]?.main ?? [];
  return inputs.flatMap((connections, input) =>
    (connections ?? []).map((c) => ({ node: c.node, output: c.index, input })),
  );
}

/**
 * The description governing `node` at its pinned `typeVersion`, or undefined
 * when the bundle does not carry that type. Unknown types are ordinary here —
 * the walker turns them into boundaries, never errors.
 */
export function nodeType(wf: Workflow, node: INode): INodeTypeDescription | undefined {
  // `getByNameAndVersion` is non-throwing here and yields undefined for a type
  // the bundle does not carry — see the note in `node-types.ts`.
  const type = wf.nodeTypes.getByNameAndVersion(node.type, node.typeVersion) as
    | { description: INodeTypeDescription }
    | undefined;
  return type?.description;
}
