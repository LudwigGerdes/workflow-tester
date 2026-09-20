import type { Mutation } from './types.js';

/** Two paths conflict when one contains the other. */
export function nested(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`) || a.startsWith(`${b}[`) || b.startsWith(`${a}[`);
}

/**
 * Every pair of mutations on independent paths.
 *
 * A pair is the smallest combination that can expose an interaction — a field
 * going missing *while* a branch changes — and covering all of them is the
 * standard all-pairs bet: most defects that need more than one input to appear
 * need exactly two. Paths that contain one another are never combined, since the
 * outer mutation would simply overwrite the inner one.
 *
 * Deterministic by construction: paths in sorted order, mutations in the order
 * the schema walk produced them.
 */
export function pairsOf(mutations: Mutation[]): Array<[Mutation, Mutation]> {
  const byPath = new Map<string, Mutation[]>();
  for (const mutation of mutations) {
    const list = byPath.get(mutation.path) ?? [];
    list.push(mutation);
    byPath.set(mutation.path, list);
  }

  const paths = [...byPath.keys()].sort();
  const pairs: Array<[Mutation, Mutation]> = [];

  for (let i = 0; i < paths.length; i += 1) {
    for (let j = i + 1; j < paths.length; j += 1) {
      const left = paths[i] as string;
      const right = paths[j] as string;
      if (nested(left, right)) continue;
      for (const a of byPath.get(left) ?? []) {
        for (const b of byPath.get(right) ?? []) {
          pairs.push([a, b]);
        }
      }
    }
  }
  return pairs;
}
