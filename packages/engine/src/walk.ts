import type { INode, INodeExecutionData, INodeParameters } from 'n8n-workflow';
import { NodeHelpers } from './n8n.js';
import { RunData, buildDataProxy, resolveParameters } from './evaluate.js';
import { loadNodeTypes, type NodeTypeSource } from './node-types.js';
import { isPureType, semanticsFor } from './semantics/index.js';
import { CodeEvalError } from './semantics/code-eval.js';
import { DeliberateStopError } from './semantics/stop-and-error.js';
import {
  ConditionEvaluationError,
  ParameterEvaluationError,
  ImpureCallError,
  UnsupportedModeError,
  type Boundary,
  type EngineInput,
  type EngineResult,
  type Failure,
  type SemanticsContext,
  type Warning,
} from './types.js';
import { buildWorkflow, nodeType, predecessors, successors } from './workflow.js';

/** A required parameter that resolved to nothing is a failure, per spec §4. */
const isEmpty = (value: unknown): boolean => value === undefined || value === '';

/**
 * Walk a workflow from its trigger, evaluating every parameter expression with
 * n8n's own engine and applying our semantics for the expression-pure node
 * kinds. Paths that reach a node we do not interpret end in a `Boundary` — a
 * first-class result meaning "verified this far", never an error.
 */
export function walk(input: EngineInput, nodeTypes: NodeTypeSource): EngineResult {
  const started = performance.now();
  const wf = buildWorkflow(input.workflow, nodeTypes);

  const trigger = wf.getNode(input.trigger);
  if (trigger === null) {
    throw new Error(
      `trigger node "${input.trigger}" is not in this workflow (have: ${Object.keys(wf.nodes).join(', ')})`,
    );
  }

  const runData = new RunData();
  const outputs: Record<string, INodeExecutionData[][]> = {};
  const failures: Failure[] = [];
  const warnings: Warning[] = [];
  const boundaries: Boundary[] = [];
  const substituted: string[] = [];
  const errorOutputs: string[] = [];
  const reachedNodes: string[] = [trigger.name];

  const triggerItems: INodeExecutionData[] = [
    { json: input.payload as INodeExecutionData['json'], pairedItem: { item: 0 } },
  ];
  runData.setOutputs(trigger.name, [triggerItems]);
  outputs[trigger.name] = [triggerItems];

  /** Nodes with data waiting to be consumed, in data-flow order. */
  const queue: string[] = successors(wf, trigger.name).map((edge) => edge.node);
  const settled = new Set<string>([trigger.name]);
  /** How often each node has stepped aside waiting for a predecessor. */
  const deferrals = new Map<string, number>();
  const nodeCount = Object.keys(wf.nodes).length;

  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (settled.has(name)) continue;

    const node = wf.getNode(name);
    if (node === null) continue;

    // Assemble input from every predecessor that has already produced data. A
    // predecessor still pending (a branch not yet walked) defers this node; one
    // that will never produce data — an unreached branch — simply contributes
    // nothing, which mirrors n8n's v1 order for the pure set.
    const incoming = predecessors(wf, name);
    const pending = incoming.some(
      (edge) => !settled.has(edge.node) && queue.includes(edge.node),
    );
    // Bounded: in a cyclic or mutually dependent graph two queued nodes can each
    // wait on the other forever. Once a node has stepped aside more often than
    // there are nodes, every predecessor that will ever settle has settled, so
    // it proceeds with whatever input arrived. n8n itself permits loops; the
    // engine has to terminate on any graph it is handed.
    if (pending && (deferrals.get(name) ?? 0) < nodeCount) {
      deferrals.set(name, (deferrals.get(name) ?? 0) + 1);
      queue.push(name);
      continue;
    }

    // Grouped by the *destination* input index: a node with several sources
    // feeding one input still sees them as one stream, while Merge sees its
    // inputs apart.
    const byInput: INodeExecutionData[][] = [];
    for (const edge of incoming) {
      const produced = runData.outputsOf(edge.node)?.[edge.output] ?? [];
      byInput[edge.input] = [...(byInput[edge.input] ?? []), ...produced];
    }
    for (let i = 0; i < byInput.length; i += 1) byInput[i] ??= [];
    const inputItems = byInput[0] ?? [];

    settled.add(name);
    reachedNodes.push(name);

    // A node we cannot run is not necessarily the end of the walk: given a
    // stand-in recorded from a real execution, everything downstream is still
    // worth checking. What is lost is this node's internals, not the rest.
    const standIn = input.substitutes?.[name];
    const substitute = (): boolean => {
      if (standIn === undefined) return false;
      const from = incoming.find((edge) => runData.outputsOf(edge.node) !== undefined);
      outputs[name] = [standIn];
      runData.setOutputs(
        name,
        [standIn],
        from === undefined
          ? undefined
          : { previousNode: from.node, previousNodeOutput: from.output },
      );
      substituted.push(name);
      // Schedule what follows, exactly as a computed node does. Recording the
      // output without this would substitute the node and still strand
      // everything downstream, which is the failure the stand-in exists to
      // prevent.
      for (const edge of successors(wf, name)) {
        if (edge.output === 0) queue.push(edge.node);
      }
      return true;
    };

    const description = nodeType(wf, node);
    // No description normally means a type outside the bundle, which is a
    // boundary. When there are no descriptions at all the absence says nothing
    // about the node, so the built-in semantics still apply.
    const semantics =
      description === undefined && nodeTypes.hasDescriptions
        ? undefined
        : semanticsFor(node.type, node.typeVersion);

    if (semantics === undefined) {
      if (substitute()) continue;
      boundaries.push({
        node: name,
        type: node.type,
        reason: isPureType(node.type) ? 'unsupported-mode' : 'not-pure',
        inputItems: byInput.flat(),
      });
      continue;
    }

    // Resolve lazily and once per item: the semantics decide which items they
    // need, and the required-parameter check reuses what they asked for.
    const resolvedByItem = new Map<number, Record<string, unknown>>();
    const ctx: SemanticsContext = {
      node,
      inputs: byInput,
      dataProxy: (itemIndex) => buildDataProxy(wf, node, runData, inputItems, itemIndex),
      resolve: (itemIndex) => {
        const cached = resolvedByItem.get(itemIndex);
        if (cached !== undefined) return cached;
        const fresh = resolveParameters(wf, node, runData, inputItems, itemIndex);
        resolvedByItem.set(itemIndex, fresh);
        return fresh;
      },
    };

    let produced;
    try {
      produced = semantics(ctx, inputItems);
    } catch (error) {
      // A mode we do not interpret ends the path as a boundary, not a failure:
      // everything up to here is still verified.
      if (error instanceof ImpureCallError && substitute()) continue;
      if (error instanceof UnsupportedModeError && substitute()) continue;
      if (error instanceof ImpureCallError) {
        // The call site ends the path, not the node: everything the code
        // computed before reaching out is still verified.
        boundaries.push({
          node: name,
          type: node.type,
          reason: 'impure-call',
          call: error.call,
          inputItems: byInput.flat(),
        });
        continue;
      }
      if (error instanceof UnsupportedModeError) {
        boundaries.push({
          node: name,
          type: node.type,
          reason: 'unsupported-mode',
          inputItems: byInput.flat(),
        });
        continue;
      }
      // A deliberate stop is an ending, not a defect — and it outranks an
      // error output: a workflow that says "stop with an error" means stop.
      if (error instanceof DeliberateStopError) {
        failures.push({
          kind: 'deliberate-stop',
          node: name,
          parameter: '',
          message: error.message,
          itemIndex: 0,
        });
        continue;
      }
      // n8n does not fail a run for a node that declares an error output: it
      // puts an error item on the node's last main output and carries on. The
      // captured fixtures show the errored node still reporting
      // `executionStatus: success`, so the output index is the only trace that
      // the error path was taken.
      if (node.onError === 'continueErrorOutput') {
        const outgoing = successors(wf, name);
        const width = outgoing.reduce((max, edge) => Math.max(max, edge.output + 1), 0);
        // A node that declares an error output has at least two: the regular
        // one and the error one, which is always the last.
        const errorIndex = Math.max(width, 2) - 1;
        const routed: INodeExecutionData[][] = Array.from({ length: errorIndex + 1 }, () => []);
        routed[errorIndex] = [
          {
            // n8n puts the user's own message here, not a wrapped one.
            json: {
              error:
                error instanceof CodeEvalError
                  ? error.raw
                  : error instanceof Error
                    ? error.message
                    : String(error),
            },
            pairedItem: { item: 0 },
          },
        ];
        errorOutputs.push(name);
        outputs[name] = routed;
        const from = incoming.find((edge) => runData.outputsOf(edge.node) !== undefined);
        runData.setOutputs(
          name,
          routed,
          from === undefined
            ? undefined
            : { previousNode: from.node, previousNodeOutput: from.output },
        );
        for (const edge of outgoing) {
          if (edge.output === errorIndex) queue.push(edge.node);
        }
        continue;
      }
      failures.push(withSource(toFailure(error, name), error, node));
      continue;
    }

    for (const [itemIndex, resolved] of resolvedByItem) {
      const missing = requiredUndefined(node, description, resolved, itemIndex);
      if (nodeTypes.exact) {
        failures.push(...missing);
      } else {
        // The descriptions are for a different n8n release, so "required" here
        // is a claim about a version the user is not running. Report it, but do
        // not fail a build over a parameter that may not be required there.
        // This is the only finding that depends on the descriptions being
        // right: expressions, Code, terminal shape and the structural checks
        // consult none of them.
        warnings.push(
          ...missing.map((failure) => ({
            kind: 'required-unverified' as const,
            node: failure.node,
            parameter: failure.parameter,
            message: `${failure.message} — checked against n8n ${nodeTypes.n8nVersion}${
              nodeTypes.requestedVersion === undefined
                ? ''
                : `, not the ${nodeTypes.requestedVersion} you asked for`
            }`,
            itemIndex: failure.itemIndex,
          })),
        );
      }
    }
    warnings.push(...(produced.warnings ?? []));

    // A node that declares an error output has one whether or not it threw:
    // the captured export shows the success case as `[[items], []]`. Widening
    // here keeps the output shape identical on both paths.
    if (node.onError === 'continueErrorOutput' && produced.outputs.length < 2) {
      produced = { ...produced, outputs: [...produced.outputs, []] };
    }

    outputs[name] = produced.outputs;
    const source = incoming.find((edge) => runData.outputsOf(edge.node) !== undefined);
    runData.setOutputs(
      name,
      produced.outputs,
      source === undefined
        ? undefined
        : { previousNode: source.node, previousNodeOutput: source.output },
    );

    const edges = successors(wf, name);
    produced.outputs.forEach((items, output) => {
      if (items.length === 0) return;
      const onward = edges.filter((edge) => edge.output === output);
      if (onward.length === 0) {
        // Only a *branching* node warns, and only about an output the editor
        // actually lets you connect. A single-output node with nothing after it
        // is the end of the workflow, not a dead branch; and Filter produces a
        // discarded output that its description does not offer, so items landing
        // there are not a dead branch either.
        const declared =
          description !== undefined && Array.isArray(description.outputs)
            ? description.outputs.length
            : produced.outputs.length;
        if (declared < 2 || output >= declared) return;
        warnings.push({
          kind: 'dead-branch',
          node: name,
          output,
          message: `${items.length} item(s) reached output ${output}, which is not connected`,
        });
        return;
      }
      for (const edge of onward) queue.push(edge.node);
    });
  }

  return {
    status: failures.length > 0 ? 'fail' : boundaries.length > 0 ? 'boundary' : 'pass',
    reachedNodes,
    outputs,
    failures,
    warnings,
    boundaries,
    substituted,
    errorOutputs,
    durationMs: performance.now() - started,
  };
}

/** Read a value out of a parameter object by a path like `rules.values[0].conditions`. */
function parameterAt(parameters: unknown, path: string): unknown {
  let node: unknown = parameters;
  for (const segment of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (segment.length === 0) continue;
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** `={{ $json.body.record.name }}` → `body.record.name` */
function payloadPathOf(expression: string): string | undefined {
  const match = /\$json\.([A-Za-z_$][\w$]*(?:[.[\]'"\w$]*[\w$\]])?)/.exec(expression);
  return match?.[1]?.replace(/\['"]?([\w$]+)['"]?\]/g, '.$1');
}

/**
 * Attach the source of a failed condition: the expression as written and the
 * payload path it reached for. This is what turns "a condition was undecidable"
 * into "body.record.name resolved to undefined" — the difference between a
 * report a user can act on and one they have to investigate.
 */
function withSource(failure: Failure, error: unknown, node: INode): Failure {
  if (!(error instanceof ConditionEvaluationError) || error.conditionIndex === undefined) {
    return failure;
  }
  const filter = parameterAt(node.parameters, error.parameter) as
    | { conditions?: Array<Record<string, unknown>> }
    | undefined;
  const raw = filter?.conditions?.[error.conditionIndex]?.[error.side ?? 'leftValue'];
  if (typeof raw !== 'string' || !raw.startsWith('=')) return failure;

  const path = payloadPathOf(raw);
  return {
    ...failure,
    expression: raw,
    ...(path === undefined ? {} : { resolvedPath: `${path} → undefined` }),
  };
}

/** Classify an error raised while resolving or applying a node. */
function toFailure(error: unknown, node: string): Failure {
  if (error instanceof ConditionEvaluationError) {
    return {
      kind: 'condition-undefined',
      node,
      parameter: error.parameter,
      message: error.message,
      itemIndex: error.itemIndex,
    };
  }
  if (error instanceof ParameterEvaluationError) {
    return {
      kind: 'expression-error',
      node,
      parameter: error.parameter,
      expression: error.expression,
      message: error.message,
      itemIndex: error.itemIndex,
    };
  }
  return {
    kind: 'expression-error',
    node,
    parameter: '',
    message: error instanceof Error ? error.message : String(error),
    itemIndex: 0,
  };
}

/** Required parameters that resolved to nothing, honouring displayOptions. */
function requiredUndefined(
  node: INode,
  description: ReturnType<typeof nodeType>,
  resolved: Record<string, unknown>,
  itemIndex: number,
): Failure[] {
  if (description === undefined) return [];
  const failures: Failure[] = [];
  for (const property of description.properties) {
    if (property.required !== true) continue;
    if (!isEmpty(resolved[property.name])) continue;
    // Resolved parameter values are exactly node parameters; the map is typed
    // loosely because expression results are `unknown` until this point.
    const values = resolved as INodeParameters;
    if (!NodeHelpers.displayParameter(values, property, node, description)) continue;
    failures.push({
      kind: 'required-undefined',
      node: node.name,
      parameter: property.name,
      message: `required parameter "${property.displayName}" resolved to undefined`,
      itemIndex,
    });
  }
  return failures;
}

/** Convenience wrapper that loads the bundle for the requested n8n version. */
export async function walkWith(input: EngineInput): Promise<EngineResult> {
  return walk(input, await loadNodeTypes(input.n8nVersion));
}
