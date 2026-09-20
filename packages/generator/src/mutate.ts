import type { Mutation } from './types.js';

interface Segment {
  key: string;
  /** True when the key holds an array whose every element the path descends into. */
  array: boolean;
}

/** `items[].sku` → the `sku` of every element of `items`. */
export function parsePath(path: string): Segment[] {
  return path
    .split('.')
    .filter((part) => part.length > 0)
    .map((part) => ({ key: part.replace(/\[\]$/, ''), array: part.endsWith('[]') }));
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Visit the parent object of every value the path names. */
function atParents(
  root: unknown,
  segments: Segment[],
  visit: (parent: Record<string, unknown>, key: string) => void,
): void {
  const walk = (node: unknown, index: number): void => {
    const segment = segments[index];
    if (segment === undefined) return;

    if (index === segments.length - 1) {
      if (isRecord(node)) visit(node, segment.key);
      return;
    }

    if (!isRecord(node)) return;
    const child = node[segment.key];
    if (segment.array && Array.isArray(child)) {
      for (const element of child) walk(element, index + 1);
    } else {
      walk(child, index + 1);
    }
  };
  walk(root, 0);
}

/** Read every value a path names. */
export function getAtPath(root: unknown, path: string): unknown[] {
  const found: unknown[] = [];
  atParents(root, parsePath(path), (parent, key) => {
    if (key in parent) found.push(parent[key]);
  });
  return found;
}

/** Remove what a path names, returning a new payload. */
export function deleteAtPath(root: unknown, path: string): unknown {
  const copy = structuredClone(root);
  atParents(copy, parsePath(path), (parent, key) => {
    delete parent[key];
  });
  return copy;
}

/** Replace what a path names, returning a new payload. */
export function setAtPath(root: unknown, path: string, value: unknown): unknown {
  const copy = structuredClone(root);
  atParents(copy, parsePath(path), (parent, key) => {
    parent[key] = structuredClone(value);
  });
  return copy;
}

/**
 * Apply one mutation to a payload. The payload is cloned first, so a mutation
 * can never disturb the example every other mutation is built from.
 */
export function applyMutation(payload: unknown, mutation: Mutation): unknown {
  return mutation.apply(structuredClone(payload));
}
