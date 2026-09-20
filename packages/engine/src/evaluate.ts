import type {
  INode,
  INodeExecutionData,
  INodeParameters,
  ISourceData,
  IWorkflowDataProxyAdditionalKeys,
  IWorkflowDataProxyData,
  Workflow,
} from 'n8n-workflow';
import { NodeHelpers, WorkflowDataProxy } from './n8n.js';
import { RunData } from './run-data.js';
import { ParameterEvaluationError } from './types.js';
import { nodeType, predecessors } from './workflow.js';

/**
 * Inert stand-ins for the execution-scoped values n8n injects. Filled with
 * harmless constants: tier 1 verifies expression *shape*, and anything that
 * genuinely depends on a live execution belongs past a boundary.
 */
const ADDITIONAL_KEYS: IWorkflowDataProxyAdditionalKeys = {
  $execution: {
    id: 'payload-contract',
    mode: 'test',
    resumeUrl: '',
    resumeFormUrl: '',
    customData: {
      set: () => {},
      setAll: () => {},
      get: () => '',
      getAll: () => ({}),
    },
  },
  $vars: {},
  $secrets: {},
};

/** The first predecessor that has already produced data, as n8n's source record. */
function sourceFor(wf: Workflow, runData: RunData, node: INode): ISourceData | null {
  for (const edge of predecessors(wf, node.name)) {
    if (runData.outputsOf(edge.node) !== undefined) {
      return { previousNode: edge.node, previousNodeOutput: edge.output, previousNodeRun: 0 };
    }
  }
  return null;
}

/** Deep-search a parameter value for the expression it carries, for error reporting. */
function findExpression(value: unknown): string | undefined {
  if (typeof value === 'string') return value.startsWith('=') ? value : undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findExpression(entry);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      const found = findExpression(entry);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Resolve every parameter of `node` for one input item, using n8n's own
 * evaluator. Defaults come from the node description first (via
 * `NodeHelpers.getNodeParameters`), so a parameter the author never set still
 * resolves the way it would in production.
 *
 * Parameters are resolved one key at a time so a failure can name the parameter
 * that caused it.
 */
/**
 * The context n8n's own data proxy hands a node: `$input`, `$json`, `$node`,
 * `$prevNode`, `$execution` and the rest.
 *
 * Built from exactly the ingredients `resolveParameters` already assembles, so
 * a Code node sees what an expression on the same node would see.
 */
export function buildDataProxy(
  wf: Workflow,
  node: INode,
  runData: RunData,
  input: INodeExecutionData[],
  itemIndex: number,
): IWorkflowDataProxyData {
  const executeData = runData.executeDataFor(node, input, sourceFor(wf, runData, node));
  return new WorkflowDataProxy(
    wf,
    runData.data,
    0,
    itemIndex,
    node.name,
    input,
    {},
    'manual',
    ADDITIONAL_KEYS,
    executeData,
  ).getDataProxy();
}

export function resolveParameters(
  wf: Workflow,
  node: INode,
  runData: RunData,
  input: INodeExecutionData[],
  itemIndex: number,
): Record<string, unknown> {
  const description = nodeType(wf, node);
  const merged: INodeParameters =
    description === undefined
      ? node.parameters
      : (NodeHelpers.getNodeParameters(
          description.properties,
          node.parameters,
          true,
          false,
          node,
          description,
        ) ?? node.parameters);

  const executeData = runData.executeDataFor(node, input, sourceFor(wf, runData, node));
  const resolved: Record<string, unknown> = {};

  for (const [parameter, value] of Object.entries(merged)) {
    try {
      resolved[parameter] = wf.expression.getParameterValue(
        value,
        runData.data,
        0,
        itemIndex,
        node.name,
        input,
        'manual',
        ADDITIONAL_KEYS,
        executeData,
      );
    } catch (error) {
      throw new ParameterEvaluationError(
        node.name,
        parameter,
        error instanceof Error ? error.message : String(error),
        findExpression(value),
        itemIndex,
      );
    }
  }

  return resolved;
}

export { RunData } from './run-data.js';
