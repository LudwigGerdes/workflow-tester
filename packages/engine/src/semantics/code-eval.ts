import { createContext, runInContext } from 'node:vm';
import { ImpureCallError } from '../types.js';

/** User code that would not parse, threw, or ran too long. */
export class CodeEvalError extends Error {
  constructor(
    readonly node: string,
    /** The user's own message, without the node prefix. */
    readonly raw: string,
  ) {
    super(`${node}: ${raw}`);
    this.name = 'CodeEvalError';
  }
}

/**
 * The message off a thrown value.
 *
 * An error thrown inside a `node:vm` sandbox is cross-realm: it fails
 * `instanceof Error` here even though it carries a perfectly good `message`.
 * Testing the property rather than the prototype is what stops `String(error)`
 * folding "Error: " into the text and prefixing it twice.
 */
const messageOf = (error: unknown): string => {
  if (typeof error === 'object' && error !== null) {
    const { message } = error as { message?: unknown };
    if (typeof message === 'string') return message;
  }
  return String(error);
};

/**
 * n8n appends the failing line to a Code node's error, and a workflow can read
 * that string off the error output and branch on it, so it is an observable
 * value rather than a diagnostic. `wrap` puts the user's first line on the
 * sandbox's second, hence the offset.
 *
 * Conservative on purpose: an unrecognised stack yields no suffix at all. A
 * missing line number is a smaller lie than a wrong one.
 */
const lineOf = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const { stack } = error as { stack?: unknown };
  if (typeof stack !== 'string') return undefined;
  const match = /evalmachine\.<anonymous>:(\d+):/.exec(stack);
  if (match?.[1] === undefined) return undefined;
  const line = Number(match[1]) - 1;
  return Number.isFinite(line) && line > 0 ? line : undefined;
};

/** n8n runs the body as a function, so a bare `return` is valid. */
const wrap = (source: string): string => `(function () {\n${source}\n})()`;

/**
 * Run a Code node's source against a prepared context.
 *
 * `node:vm` gives the code a fresh realm: it keeps the standard library, which
 * user code needs, while `require` and `process` are simply absent rather than
 * blocked — they are injected by Node's module loader, not part of JavaScript.
 * There is no denylist to keep up to date.
 *
 * A new context per call means two evaluations cannot see each other's globals,
 * so one case cannot contaminate the next.
 *
 * The timeout is defence in depth. `walk` already runs inside a worker with a
 * wall-clock ceiling; this one fires first and names the node, so a runaway
 * loop is attributed instead of killing the whole case anonymously.
 */
export function evaluateCode(
  source: string,
  context: Record<string, unknown>,
  node: string,
  timeoutMs = 1_000,
): unknown {
  const sandbox = createContext(Object.assign(Object.create(null) as object, context));
  try {
    return runInContext(wrap(source), sandbox, { timeout: timeoutMs });
  } catch (error) {
    // An impure call is control flow, not an evaluation failure: the walker
    // turns it into a boundary. Wrapping it here would report a broken node
    // where the truth is an unverified one.
    if (error instanceof ImpureCallError) throw error;
    const line = lineOf(error);
    throw new CodeEvalError(
      node,
      line === undefined ? messageOf(error) : `${messageOf(error)} [line ${line}]`,
    );
  }
}
