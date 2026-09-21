import { readChain, toFocusSegments, type Chain } from 'workflow-test-structure';
import { ExpressionParser } from './n8n.js';
import type { FocusPath } from './types.js';

/** The slice of workflow JSON the generator needs; deliberately its own. */
export interface WorkflowJson {
  id?: string;
  name?: string;
  nodes: Array<{
    name: string;
    type: string;
    typeVersion: number;
    parameters?: Record<string, unknown>;
  }>;
  connections: Record<string, { main?: Array<Array<{ node: string; index: number }> | null> }>;
}

/** Node kinds that hand their input straight through, unchanged. */
const PASS_THROUGH = new Set([
  'n8n-nodes-base.noOp',
  'n8n-nodes-base.if',
  'n8n-nodes-base.filter',
  'n8n-nodes-base.switch',
  'n8n-nodes-base.limit',
  'n8n-nodes-base.sort',
  'n8n-nodes-base.removeDuplicates',
]);

const SET = 'n8n-nodes-base.set';
const CODE = 'n8n-nodes-base.code';

/**
 * What a caller observed about a Code node.
 *
 * A Code node is arbitrary JavaScript, so nothing about its output can be
 * claimed by reading the workflow. But a caller that has actually run one can
 * say which fields came out the other side, and a field that went in and came
 * out again still traces back to the trigger. Without an observation the answer
 * stays "unknown", which is what it was before.
 */
export interface FocusOptions {
  /** Did `path` survive this node, as observed by whoever ran it? */
  survives?: (node: string, path: string) => boolean;
}

/** Maps a path read off `$json` at some node back to a trigger-payload path. */
type Lineage = (path: string) => string | undefined;

const IDENTITY: Lineage = (path) => path;
const UNKNOWN: Lineage = () => undefined;

interface Reference {
  /** `json` means "this node's input"; otherwise a named node. */
  root: { kind: 'json' } | { kind: 'node'; node: string };
  /** Collapsed for the generator: `body.items[].sku`. Absent when uncollapsible. */
  path?: string;
  /** Literal indices intact, for consumers that need them. */
  chain: Chain;
}

/** A root token, and where its accessor chain begins. */
const ROOTS: Array<{ pattern: RegExp; nodeFrom?: number }> = [
  // `$('Name').item.json`, `.first().json`, `.all()[0].json`, `.itemMatching(…).json`
  {
    pattern:
      /\$\(\s*['"]([^'"]+)['"]\s*\)\s*\??\.\s*(?:item|first\(\s*\)|last\(\s*\)|all\(\s*\)\s*\[\s*\d+\s*\]|itemMatching\([^)]*\))\s*\??\.\s*json\b/g,
    nodeFrom: 1,
  },
  // `$input.item.json` and friends resolve exactly like `$json`
  {
    pattern:
      /\$input\s*\??\.\s*(?:item|first\(\s*\)|last\(\s*\)|all\(\s*\)\s*\[\s*\d+\s*\])\s*\??\.\s*json\b/g,
  },
  { pattern: /\$json\b/g },
];

/** Every payload reference in one expression string. */
function referencesIn(expression: string): Reference[] {
  const found: Reference[] = [];
  const segments = ExpressionParser.splitExpression(expression);

  for (const segment of segments) {
    if (segment.type !== 'code') continue;
    const code = segment.text;

    for (const { pattern, nodeFrom } of ROOTS) {
      const regex = new RegExp(pattern.source, 'g');
      let match = regex.exec(code);
      while (match !== null) {
        const chain = readChain(code, match.index + match[0].length);
        if (chain !== undefined) {
          const segments = toFocusSegments(chain);
          found.push({
            root:
              nodeFrom === undefined
                ? { kind: 'json' }
                : { kind: 'node', node: match[nodeFrom] as string },
            ...(segments === undefined ? {} : { path: segments.join('.') }),
            chain,
          });
        }
        match = regex.exec(code);
      }
    }
  }
  return found;
}

/** Every expression in a node's parameters, with the path that names it. */
function expressionsOf(
  value: unknown,
  parameter: string,
  out: Array<{ parameter: string; expression: string }>,
): void {
  if (typeof value === 'string') {
    if (value.startsWith('=')) out.push({ parameter, expression: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => expressionsOf(entry, `${parameter}[${index}]`, out));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      expressionsOf(entry, parameter === '' ? key : `${parameter}.${key}`, out);
    }
  }
}

/**
 * Extract the trigger-payload paths a workflow actually reads.
 *
 * Variation is only worth generating where it can change behaviour, so this is
 * what keeps case sets small and every failure explainable. Paths are resolved
 * back to the trigger through Set lineage; anything whose origin cannot be
 * traced is dropped rather than guessed at.
 */
export function extractFocusPaths(
  workflow: WorkflowJson,
  trigger: string,
  options: FocusOptions = {},
): FocusPath[] {
  const byName = new Map(workflow.nodes.map((node) => [node.name, node]));
  const collected = new Map<string, FocusPath>();

  const record = (path: string, node: string, parameter: string, expression: string): void => {
    const existing = collected.get(path);
    if (existing === undefined) {
      collected.set(path, { path, sources: [{ node, parameter, expression }] });
      return;
    }
    const seen = existing.sources.some(
      (s) => s.node === node && s.parameter === parameter && s.expression === expression,
    );
    if (!seen) existing.sources.push({ node, parameter, expression });
  };

  /** What `$json` means at each node, in data-flow order from the trigger. */
  const lineageOf = new Map<string, Lineage>();
  const queue: string[] = [];

  for (const edge of workflow.connections[trigger]?.main?.flat() ?? []) {
    if (edge === null) continue;
    lineageOf.set(edge.node, IDENTITY);
    queue.push(edge.node);
  }

  const visited = new Set<string>([trigger]);

  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (visited.has(name)) continue;
    visited.add(name);

    const node = byName.get(name);
    const lineage = lineageOf.get(name) ?? UNKNOWN;
    if (node === undefined) continue;

    const expressions: Array<{ parameter: string; expression: string }> = [];
    expressionsOf(node.parameters ?? {}, '', expressions);

    /** Resolve one reference to a trigger path, or nothing. */
    const resolve = (reference: Reference): string | undefined =>
      reference.path === undefined
        ? undefined
        : reference.root.kind === 'node'
          ? reference.root.node === trigger
            ? reference.path
            : undefined
          : lineage(reference.path);

    for (const { parameter, expression } of expressions) {
      for (const reference of referencesIn(expression)) {
        const path = resolve(reference);
        if (path !== undefined) record(path, name, parameter, expression);
      }
    }

    // What this node's output means to whatever reads it next.
    let downstream: Lineage = UNKNOWN;
    const survives = options.survives;
    if (node.type === CODE) {
      // Only what was seen to come out carries lineage. No observation, no
      // claim — the node stays opaque, exactly as before.
      downstream =
        survives === undefined
          ? UNKNOWN
          : (path) => (survives(node.name, path) ? lineage(path) : undefined);
    } else if (PASS_THROUGH.has(node.type)) {
      downstream = lineage;
    } else if (node.type === SET) {
      const parameters = node.parameters ?? {};
      const collection = parameters.assignments as
        | { assignments?: Array<{ name?: string; value?: unknown }> }
        | undefined;

      const renamed = new Map<string, string>();
      for (const assignment of collection?.assignments ?? []) {
        if (typeof assignment.name !== 'string' || typeof assignment.value !== 'string') continue;
        // A Set that copies exactly one field carries that field's lineage.
        const references = referencesIn(assignment.value);
        if (references.length !== 1) continue;
        const source = resolve(references[0] as Reference);
        if (source !== undefined) renamed.set(assignment.name, source);
      }

      const passOthers = parameters.includeOtherFields === true;
      downstream = (path) => {
        const [head, ...rest] = path.split('.');
        const mapped = head === undefined ? undefined : renamed.get(head);
        if (mapped !== undefined) return [mapped, ...rest].join('.');
        return passOthers ? lineage(path) : undefined;
      };
    }

    for (const edge of workflow.connections[name]?.main?.flat() ?? []) {
      if (edge === null) continue;
      if (!lineageOf.has(edge.node)) lineageOf.set(edge.node, downstream);
      queue.push(edge.node);
    }
  }

  return [...collected.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** One access chain, and where in the workflow it was written. */
export interface NodeChain {
  node: string;
  parameter: string;
  expression: string;
  root: { kind: 'json' } | { kind: 'node'; node: string };
  chain: Chain;
}

/**
 * Every access chain in a workflow, with literal indices intact.
 *
 * Unlike `extractFocusPaths` this does not resolve lineage back to the trigger
 * and does not drop what it cannot trace: the checker reasons about a chain
 * against the shape at the node that wrote it, so an untraceable origin costs
 * nothing.
 */
export function chainsIn(workflow: WorkflowJson): NodeChain[] {
  const out: NodeChain[] = [];
  for (const node of workflow.nodes) {
    const expressions: Array<{ parameter: string; expression: string }> = [];
    expressionsOf(node.parameters ?? {}, '', expressions);
    for (const { parameter, expression } of expressions) {
      for (const reference of referencesIn(expression)) {
        out.push({
          node: node.name,
          parameter,
          expression,
          root: reference.root,
          chain: reference.chain,
        });
      }
    }
  }
  return out;
}
