import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { INodeExecutionData } from 'n8n-workflow';
import { parse as parseYaml } from 'yaml';
import { setOwn, type Shape } from './shape.js';
import { synthesizeItems } from './synthesize.js';

/** What one node produced, as recorded in the sidecar. Shape only, never values. */
export interface CapturedNode {
  /** Stable across renames, so a rename is not read as a deletion. */
  id?: string;
  shape: Shape;
  items: number;
}

export interface CaptureRecord {
  capturedAt: string;
  executionId?: string;
  /** Set when the workflow is active but has not run yet. */
  awaitingFirstExecution?: true;
  nodes?: Record<string, CapturedNode>;
}

/** The sidecar beside a workflow, which is what makes a capture travel with it. */
export const sidecarFor = (workflowFile: string): string =>
  workflowFile.replace(/\.json$/, '.contract.yaml');

/** Read a workflow's recorded capture, if it has one. */
export function readCapture(workflowFile: string): CaptureRecord | undefined {
  const sidecar = sidecarFor(workflowFile);
  if (!existsSync(sidecar)) return undefined;
  const parsed = parseYaml(readFileSync(sidecar, 'utf8')) as { capture?: CaptureRecord } | null;
  return parsed?.capture;
}

/**
 * Stand-in output for every node a capture recorded.
 *
 * The engine uses these to carry on past a node it cannot run, so an HTTP call
 * in the middle of a workflow costs you that node rather than everything after
 * it. Values are invented from the recorded shape — see `synthesize` for what
 * that does and does not prove.
 */
export function substitutesFor(workflowFile: string): Record<string, INodeExecutionData[]> {
  const capture = readCapture(workflowFile);
  const substitutes: Record<string, INodeExecutionData[]> = {};
  for (const [name, node] of Object.entries(capture?.nodes ?? {})) {
    setOwn(substitutes, name, synthesizeItems(node.shape) as INodeExecutionData[]);
  }
  return substitutes;
}

/** A hand-written correction to what workflow-test inferred about an ending. */
export interface OutcomeDeclaration {
  node: string;
  expect: 'success' | 'failure';
  reason?: string;
}

/**
 * Declared outcomes for a workflow, from its sidecar.
 *
 * Optional by construction: inference runs first and a declaration only
 * overrides what it decided, so a workflow that declares nothing still gets
 * classified. An entry whose `expect` is neither `success` nor `failure` is
 * dropped rather than guessed at.
 */
export function outcomesFor(workflowFile: string): OutcomeDeclaration[] {
  const sidecar = sidecarFor(workflowFile);
  if (!existsSync(sidecar)) return [];
  const parsed = parseYaml(readFileSync(sidecar, 'utf8')) as
    | { outcomes?: Array<{ node?: unknown; expect?: unknown; reason?: unknown }> }
    | null;
  const declared: OutcomeDeclaration[] = [];
  for (const entry of parsed?.outcomes ?? []) {
    if (typeof entry.node !== 'string') continue;
    if (entry.expect !== 'success' && entry.expect !== 'failure') continue;
    declared.push({
      node: entry.node,
      expect: entry.expect,
      ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
    });
  }
  return declared;
}

const SKIP_DIRS = new Set(['.workflow-test', 'node_modules', '.git', 'dist']);

/**
 * Every `*.contract.yaml` under `dir`, a few levels deep.
 *
 * One definition, in the package that owns sidecars: the runner and `sync` both
 * need it, and two walks would drift on which directories they skip.
 */
export function sidecarsUnder(dir: string, depth = 0): string[] {
  if (depth > 4 || !existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...sidecarsUnder(join(dir, entry.name), depth + 1));
    } else if (entry.name.endsWith('.contract.yaml')) {
      found.push(join(dir, entry.name));
    }
  }
  return found.sort();
}
