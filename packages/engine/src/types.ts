import type {
  IConnections,
  INode,
  INodeExecutionData,
  IWorkflowDataProxyData,
} from 'n8n-workflow';

/** A workflow as it sits on disk: an n8n export, an API response, or hand-edited JSON. */
export interface WorkflowJson {
  id?: string;
  name?: string;
  nodes: INode[];
  connections: IConnections;
  settings?: { timezone?: string; executionOrder?: string };
}

export interface EngineInput {
  workflow: WorkflowJson;
  /** Name of the trigger node the payload enters at. */
  trigger: string;
  /** Already envelope-wrapped item json (see `workflow-test-contracts` `wrapWebhook`). */
  payload: unknown;
  n8nVersion?: string;
  /**
   * Stand-in output for nodes the engine cannot run — an HTTP call, anything
   * credentialed, a Code node that reaches outside itself. Given one, the walk
   * substitutes it and carries on, so a single unrunnable node costs you that
   * node rather than the whole workflow downstream of it.
   *
   * Items, not shapes: building them from a recorded shape is the caller's
   * business, which keeps this package free of contract knowledge.
   */
  substitutes?: Record<string, INodeExecutionData[]>;
}

export interface Failure {
  kind: 'expression-error' | 'required-undefined' | 'condition-undefined' | 'deliberate-stop';
  node: string;
  parameter: string;
  expression?: string;
  message: string;
  /** The chain that resolved to nothing, e.g. `body.record.name → undefined`. */
  resolvedPath?: string;
  itemIndex: number;
}

export interface Warning {
  kind: 'optional-undefined' | 'dead-branch' | 'code-log' | 'required-unverified';
  node: string;
  parameter?: string;
  output?: number;
  message: string;
  itemIndex?: number;
}

/**
 * A path that ended at a node the engine does not interpret. Not an error: the
 * workflow is verified up to here, and `inputItems` is what tier 2 pins.
 */
export interface Boundary {
  node: string;
  type: string;
  reason: 'not-pure' | 'unsupported-mode' | 'impure-call';
  /** Which call ended the path. Present only for `impure-call`. */
  call?: string;
  inputItems: INodeExecutionData[];
}

export interface EngineResult {
  status: 'pass' | 'fail' | 'boundary';
  /** Execution order. */
  reachedNodes: string[];
  /** Node → per-output-index items. Pure nodes only. */
  outputs: Record<string, INodeExecutionData[][]>;
  failures: Failure[];
  warnings: Warning[];
  /** One per path that hit a non-pure node. */
  boundaries: Boundary[];
  /**
   * Nodes whose output was substituted rather than computed. Verified against
   * a stand-in is not the same claim as verified, and a report must not blur
   * the two.
   */
  substituted: string[];
  /**
   * Nodes that routed a throw to their error output rather than failing. n8n
   * reports such a run as a success at both node and run level — the captured
   * fixtures show the errored node itself reporting `executionStatus: success` —
   * so this is the only record that the error path was taken.
   */
  errorOutputs: string[];
  durationMs: number;
}

export interface SemanticsContext {
  node: INode;
  /** Fully-resolved parameters for that item, via n8n's own evaluator. */
  resolve: (itemIndex: number) => Record<string, unknown>;
  /**
   * The context n8n's own data proxy would hand this node — `$input`, `$json`,
   * `$node` and the rest. Semantics that run user code build their sandbox from
   * this rather than reimplementing the members.
   */
  dataProxy: (itemIndex: number) => IWorkflowDataProxyData;
  /**
   * Items per input index. Single-input nodes take what they need from the
   * `input` argument; Merge is the reason this exists, since telling input 1
   * from input 2 is the whole of its semantics.
   */
  inputs: INodeExecutionData[][];
}

export type Semantics = (
  ctx: SemanticsContext,
  input: INodeExecutionData[],
) => { outputs: INodeExecutionData[][]; warnings?: Warning[] };

/**
 * Thrown when resolving a node's parameters fails, carrying what the walker
 * needs to classify it. Deliberately *not* named `ExpressionError`: the engine
 * re-exports n8n's own class of that name from `./n8n.js`, and two of them in
 * one package is a footgun.
 */
export class ParameterEvaluationError extends Error {
  constructor(
    readonly node: string,
    readonly parameter: string,
    message: string,
    readonly expression?: string,
    readonly itemIndex = 0,
  ) {
    super(message);
    this.name = 'ParameterEvaluationError';
  }
}

/**
 * Thrown when a routing condition cannot be decided — n8n's filter executor
 * rejects a comparison whose operand is undefined under strict type validation.
 * The walker converts this into a `condition-undefined` failure.
 */
export class ConditionEvaluationError extends Error {
  constructor(
    readonly node: string,
    readonly parameter: string,
    message: string,
    readonly itemIndex = 0,
    /** Which condition could not be decided, so the walker can find its source. */
    readonly conditionIndex?: number,
    readonly side?: 'leftValue' | 'rightValue',
  ) {
    super(message);
    this.name = 'ConditionEvaluationError';
  }
}

/**
 * Thrown when Code reaches outside its own node — an HTTP helper, static data.
 * The walker turns this into a boundary at the call site: everything computed
 * before the call is still verified, and only the rest of that path is unknown.
 */
export class ImpureCallError extends Error {
  constructor(
    readonly node: string,
    readonly call: string,
  ) {
    super(`${node} called ${call}, which reaches outside the workflow`);
    this.name = 'ImpureCallError';
  }
}

/**
 * Thrown by semantics that recognise the node but not the mode it is configured
 * in — Switch in expression mode, Merge combining by fields, Sort by code. The
 * walker turns this into a `boundary`, not a failure: the workflow is verified
 * up to here and the rest is tier 2's business.
 */
export class UnsupportedModeError extends Error {
  constructor(
    readonly node: string,
    message: string,
  ) {
    super(message);
    this.name = 'UnsupportedModeError';
  }
}
