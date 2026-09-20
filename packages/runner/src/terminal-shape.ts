import { diffShape, shapeOfItems, type CaptureRecord, type ShapeChange } from 'payload-contract-contracts';
import type { EngineResult } from 'payload-contract-engine';
import type { Terminus } from './termini.js';

export interface TerminalShapeFinding {
  node: string;
  changes: ShapeChange[];
}

export interface TerminalShapeReport {
  findings: TerminalShapeFinding[];
  /**
   * Termini with no recorded shape to compare against. Named rather than
   * skipped: a terminus nobody ever captured is the case where a green result
   * would claim the most and check the least.
   */
  unchecked: string[];
}

/**
 * Check what a run's endings produced against what the capture recorded.
 *
 * The recorded shape at a terminal node is the author's success criterion,
 * written down by the act of running the workflow once. This is where that
 * becomes an assertion instead of a note.
 */
export function checkTerminalShape(
  result: EngineResult,
  capture: CaptureRecord | undefined,
  termini: Terminus[],
): TerminalShapeReport {
  const findings: TerminalShapeFinding[] = [];
  const unchecked: string[] = [];

  // With no capture there is nothing to be unchecked *against*. A hand-written
  // or generated case carries its own expectations, and reporting "no recorded
  // shape" for it would turn every existing suite yellow over a capture nobody
  // asked for. A case derived from a capture always has one, so the guarantee
  // that such a case never passes vacuously is untouched.
  if (capture === undefined) return { findings, unchecked };

  for (const terminus of termini) {
    const recorded = capture?.nodes?.[terminus.node];
    if (recorded === undefined) {
      unchecked.push(terminus.node);
      continue;
    }
    const items = (result.outputs[terminus.node] ?? []).flat();
    if (items.length === 0) {
      unchecked.push(terminus.node);
      continue;
    }
    const changes = diffShape(recorded.shape, shapeOfItems(items));
    if (changes.length > 0) findings.push({ node: terminus.node, changes });
  }

  return { findings, unchecked };
}
