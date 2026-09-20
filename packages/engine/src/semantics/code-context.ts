import type { IWorkflowDataProxyData } from 'n8n-workflow';
import { ImpureCallError } from '../types.js';

export interface CodeContextOptions {
  node: string;
  /** What n8n's own data proxy hands a Code node: $input, $json, $node, … */
  proxy: IWorkflowDataProxyData;
  /** Seeds Math.random and Date.now so a case reproduces exactly. */
  seed: string;
}

export interface CodeContext {
  context: Record<string, unknown>;
  /** Mutable sink the console stub writes into; read after evaluation. */
  logs: string[];
}

/**
 * A small deterministic PRNG. Real entropy would make every run a different
 * case, and a suite whose results move on their own teaches people to ignore it.
 */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The instant a frozen clock reports. */
const EPOCH = 0;

/**
 * A `Date` that is deterministic but still a real constructor.
 *
 * `new Date()` with no arguments is the non-deterministic case, so it is
 * pinned; every other form is left alone, because a Code node parsing a date
 * out of its input must get the date it was given.
 */
class FrozenDate extends Date {
  constructor(...args: unknown[]) {
    super(...((args.length === 0 ? [EPOCH] : args) as ConstructorParameters<typeof Date>));
  }

  static override now(): number {
    return EPOCH;
  }
}

/** Everything reaching outside the node fails the same way, naming itself. */
const impure =
  (node: string, call: string) =>
  (): never => {
    throw new ImpureCallError(node, call);
  };

/**
 * Assemble the context a Code node runs against.
 *
 * The data members — `$input`, `$json`, `$node`, `$prevNode`, `$execution` and
 * the rest — come from n8n's own `WorkflowDataProxy`, which is how n8n itself
 * builds them. Reimplementing those would mean guessing at behaviour we can
 * simply use, and a member we invent is one whose divergence from real n8n no
 * test here would ever notice.
 *
 * Only three things are ours, because only three cannot come from the proxy:
 * the calls that reach outside the workflow and must fail, the sources of
 * non-determinism that must be frozen, and console output that is worth
 * keeping.
 */
export function buildCodeContext(options: CodeContextOptions): CodeContext {
  const { node, proxy, seed } = options;
  const random = seeded(seed);
  const logs: string[] = [];
  const record = (...args: unknown[]): void => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };

  return {
    logs,
    context: {
      ...proxy,

      // Reaches the instance's stored state, which no offline run can know.
      $getWorkflowStaticData: impure(node, '$getWorkflowStaticData'),
      $helpers: {
        httpRequest: impure(node, '$helpers.httpRequest'),
        requestWithAuthentication: impure(node, '$helpers.requestWithAuthentication'),
      },

      // Frozen, so the same case yields the same result on any day and machine.
      // Both must stay usable in full: real Code nodes call `new Date()` and
      // `Math.floor` far more often than the members being pinned.
      Math: Object.assign(Object.create(Math) as Math, { random }),
      Date: FrozenDate,

      // Kept rather than dropped: console is how people debug these, and the
      // output is worth surfacing in a report.
      console: { log: record, warn: record, error: record, info: record, debug: record },
    },
  };
}
