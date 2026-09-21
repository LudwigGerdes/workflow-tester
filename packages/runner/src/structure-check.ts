import { shapeOfItems, type Shape } from 'workflow-tester-contracts';
import type { EngineResult } from 'workflow-tester-engine';
import { chainsIn, type NodeChain, type WorkflowJson } from 'workflow-tester-generator';
import {
  checkChain,
  guardsPrefix,
  inConditionalBranch,
  renderChain,
  type Finding,
} from 'workflow-tester-structure';
import type { Outcome } from './oracle.js';

export interface StructureFinding extends Finding {
  node: string;
  parameter: string;
  /** The chain as written, e.g. `body.items.sku`. */
  chain: string;
}

export interface StructureReport {
  findings: StructureFinding[];
  /**
   * Chains skipped because no shape was available to check them against. Named
   * in the report rather than passed over: a check that silently examined
   * nothing would read as a clean bill of health.
   */
  unresolved: number;
}

/** Every node that feeds this one. */
function predecessorsOf(workflow: WorkflowJson, node: string): string[] {
  const out: string[] = [];
  for (const [from, connection] of Object.entries(workflow.connections)) {
    for (const output of connection.main ?? []) {
      for (const edge of output ?? []) {
        if (edge.node === node) out.push(from);
      }
    }
  }
  return out;
}

/** The observed output shape of a node, if the walk produced one. */
function outputShape(result: EngineResult, node: string): Shape | undefined {
  const outputs = result.outputs[node];
  if (outputs === undefined) return undefined;
  const items = outputs.flat();
  if (items.length === 0) return undefined;
  return shapeOfItems(items);
}

/** The shape a chain's root resolves to at the node that wrote it. */
function rootShape(
  workflow: WorkflowJson,
  result: EngineResult,
  reference: NodeChain,
): Shape | undefined {
  if (reference.root.kind === 'node') return outputShape(result, reference.root.node);
  for (const predecessor of predecessorsOf(workflow, reference.node)) {
    const shape = outputShape(result, predecessor);
    if (shape !== undefined) return shape;
  }
  return undefined;
}

/**
 * Check every access chain in a workflow against the shape the data had.
 *
 * Shapes come from the walk that just ran, so this reports against what
 * actually flowed rather than against a schema someone wrote down.
 */
export function checkStructure(workflow: WorkflowJson, result: EngineResult): StructureReport {
  const findings: StructureFinding[] = [];
  let unresolved = 0;

  // Nodes where something actually failed to resolve. If a conditional branch
  // broke, the walk says so, and that evidence outranks any reading of the
  // expression's syntax.
  const broke = new Set([
    ...result.failures.map((f) => f.node),
    ...result.warnings.map((w) => w.node),
  ]);

  for (const reference of chainsIn(workflow)) {
    const shape = rootShape(workflow, result, reference);
    if (shape === undefined) {
      unresolved += 1;
      continue;
    }
    for (const finding of checkChain(shape, reference.chain)) {
      // A guarded read is the author saying the value may be missing. Reading
      // `login` off a null is only a defect when nothing checked first.
      if (
        finding.kind === 'container-mismatch' &&
        // Matched on the chain as written rather than a reconstructed root:
        // a root is `$json` in one expression and `$('Some Node').item.json`
        // in another, and the path after it is what the guard sits on.
        guardsPrefix(reference.expression, finding.at)
      ) {
        continue;
      }
      // A read inside a conditional branch may simply not have run. Still
      // reported — the shape would break it if the branch were taken — but as a
      // possibility rather than a certainty.
      const severity =
        finding.kind === 'container-mismatch' &&
        !broke.has(reference.node) &&
        inConditionalBranch(reference.expression, finding.at)
          ? ('warn' as const)
          : finding.severity;

      findings.push({
        ...finding,
        severity,
        node: reference.node,
        parameter: reference.parameter,
        chain: renderChain(reference.chain),
      });
    }
  }

  return { findings, unresolved };
}

/**
 * Fold a structure report into an outcome.
 *
 * A structural failure fails the case: the chain is wrong regardless of whether
 * anything downstream happened to require the value it produced. Warnings raise
 * a passing case to `warn` and leave anything worse untouched.
 */
export function applyStructure(outcome: Outcome, report: StructureReport): Outcome {
  if (report.findings.length === 0) return outcome;

  const worst = report.findings.some((f) => f.severity === 'fail') ? 'fail' : 'warn';
  const status =
    outcome.status === 'fail' || worst === 'fail'
      ? 'fail'
      : outcome.status === 'pass'
        ? 'warn'
        : outcome.status;

  return { ...outcome, status, structure: report.findings };
}
