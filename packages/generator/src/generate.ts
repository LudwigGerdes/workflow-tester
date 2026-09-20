import { stableHash } from './hash.js';
import { applyMutation } from './mutate.js';
import { pairsOf } from './pairwise.js';
import { enumerateMutations } from './schema-walk.js';
import type { Case, GenerateStats, Mutation, MutationRecord } from './types.js';

export interface TaggedExample {
  event?: string;
  payload: unknown;
}

export interface GenerateInput {
  schema: unknown;
  examples: TaggedExample[];
  /** Trigger-payload paths the workflow reads. */
  focus: Set<string>;
  overrides?: { required?: string[]; never?: string[] };
  /** Cap per contract; examples are never what gets dropped. */
  max?: number;
  /**
   * Nodes in the workflow. The budget is derived from it — a workflow is worth
   * testing in proportion to how much of it there is — unless `max` says
   * otherwise.
   */
  nodeCount?: number;
  /** Identifies the contract, so ids differ between contracts. */
  contractKey: string;
}

const record = (mutation: Mutation): MutationRecord => ({
  kind: mutation.kind,
  path: mutation.path,
  detail: mutation.detail,
  ...(mutation.synthesized === true ? { synthesized: true } : {}),
});

const titleOf = (mutations: Mutation[]): string =>
  mutations.map((m) => `${m.kind} ${m.path}${m.detail === '' ? '' : ` (${m.detail})`}`).join(' + ');

/**
 * Turn a contract's shape and examples into the cases worth running.
 *
 * Examples come first and always survive the cap — they are the realism anchor,
 * and a run that dropped them would be testing only variants of something it
 * never checked. Then single mutations, then pairs, each ordered so that the
 * same inputs always produce the same file names in the same order.
 */
export function generate(input: GenerateInput): { cases: Case[]; stats: GenerateStats } {
  // Roughly three and a half cases per node, which is what it takes to cover
  // the payload shapes a node's expressions actually read. An explicit `max`
  // still wins; without either, the old flat cap stands.
  const budget =
    input.max ?? (input.nodeCount === undefined ? 200 : Math.round(3.5 * input.nodeCount));

  /** Does the workflow read this path, or anything beneath it? */
  const touchesFocus = (path: string): boolean =>
    [...input.focus].some(
      (f) => f === path || f.startsWith(`${path}.`) || f.startsWith(`${path}[`),
    );
  const cases: Case[] = [];
  const stats: GenerateStats = { examples: 0, single: 0, pairs: 0, truncated: 0 };

  const push = (
    exampleIndex: number,
    event: string | undefined,
    mutations: Mutation[],
    payload: unknown,
    tags: string[],
  ): void => {
    const records = mutations.map(record);
    cases.push({
      id: stableHash({ contract: input.contractKey, exampleIndex, mutations: records }),
      title: mutations.length === 0 ? `example #${exampleIndex}${event === undefined ? '' : ` (${event})`}` : titleOf(mutations),
      tags,
      ...(event === undefined ? {} : { event }),
      payload,
      provenance: { exampleIndex, mutations: records },
    });
  };

  // 1. Every example, verbatim.
  input.examples.forEach((example, index) => {
    push(index, example.event, [], example.payload, ['example']);
    stats.examples += 1;
  });

  // 2. One case per single mutation, per example.
  const perExample = input.examples.map((example) =>
    enumerateMutations(input.schema, example.payload, {
      focus: input.focus,
      overrides: input.overrides,
      examples: input.examples.map((e) => e.payload),
    }),
  );

  perExample.forEach((mutations, index) => {
    const example = input.examples[index] as TaggedExample;
    for (const mutation of mutations) {
      push(index, example.event, [mutation], applyMutation(example.payload, mutation), ['single', mutation.kind]);
      stats.single += 1;
    }
  });

  // 3. Pairs, over the first example only: an interaction between two fields
  //    shows up on one example as readily as on all of them, and doing this per
  //    example multiplies the set without adding coverage.
  const first = input.examples[0];
  const firstMutations = perExample[0];
  if (first !== undefined && firstMutations !== undefined) {
    for (const [a, b] of pairsOf(firstMutations)) {
      // Neither half is read, so the pair cannot distinguish anything. On a real
      // GitHub webhook workflow this was 62% of the candidates.
      if (!touchesFocus(a.path) && !touchesFocus(b.path)) continue;
      const payload = applyMutation(applyMutation(first.payload, a), b);
      push(0, first.event, [a, b], payload, ['pair', a.kind, b.kind]);
      stats.pairs += 1;
    }
  }

  /**
   * What the budget buys first.
   *
   * Tiers 0-2 are the floor and always survive: an example for realism, then
   * every single mutation on a path the workflow reads — which is where
   * findings actually come from. On the workflow this was measured against,
   * both real defects were tier 1 and nothing else found anything. Pairs and
   * unread paths compete for whatever budget is left.
   */
  const rank = (entry: Case): number => {
    if (entry.tags.includes('example')) return 0;
    const mutations = entry.provenance.mutations;
    const focused = mutations.some((m) => touchesFocus(m.path));
    if (mutations.length === 1 && focused) {
      return mutations[0]?.kind === 'nullable-null' ? 1 : 2;
    }
    if (!focused) return 5;
    // Two nulls at once is where an interaction bug hides: each field alone is
    // handled and the combination is not, which no single mutation can reach.
    // Every defect found so far has been a null, so this is the pair worth
    // buying first.
    return mutations.every((m) => m.kind === 'nullable-null' && touchesFocus(m.path)) ? 3 : 4;
  };

  /** Tiers at or below this are never dropped, whatever the budget says. */
  const FLOOR = 2;

  cases.sort((x, y) => {
    const byRank = rank(x) - rank(y);
    if (byRank !== 0) return byRank;
    const byExample = x.provenance.exampleIndex - y.provenance.exampleIndex;
    if (byExample !== 0) return byExample;
    const byTitle = x.title.localeCompare(y.title);
    return byTitle !== 0 ? byTitle : x.id.localeCompare(y.id);
  });

  // Never let the *derived* budget cut into the floor: sorted by tier, so
  // keeping at least `floor` entries keeps exactly the ones that must survive.
  // An explicit `max` is a decision someone made on purpose and still wins —
  // a flag named max that quietly returns more would be worse than the loss.
  const floor = input.max === undefined ? cases.filter((entry) => rank(entry) <= FLOOR).length : 0;
  const keep = Math.max(budget, floor);

  if (cases.length > keep) {
    stats.truncated = cases.length - keep;
    cases.length = keep;
    // Stats describe what came back, not what was considered; `truncated` is
    // where the difference is recorded. A reporter printing "259 pairs" beside
    // 174 pair files would just be wrong.
    stats.single = cases.filter((c) => c.provenance.mutations.length === 1).length;
    stats.pairs = cases.filter((c) => c.provenance.mutations.length === 2).length;
  }

  return { cases, stats };
}
