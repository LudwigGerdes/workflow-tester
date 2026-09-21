/**
 * What a case expects.
 *
 * Keys are written as the author wrote them and passed through untouched — the
 * owner's fixture carries both the flat dotted form (`execution.status`,
 * `node.Slack.items`, `node.Fetch.output[0].json.id`) and a nested one, and a
 * loader that normalised either would no longer round-trip what it was given.
 * `calls` and `noUnmatched` are tier-2 only.
 */
export type Then = Record<string, unknown>;

/** A trigger is named directly, or given with its own payload. */
export type WhenTrigger = string | { node?: string; payload?: unknown };

/** One case in a suite: a payload to send and, optionally, what to expect. */
export interface SuiteCase {
  id: string;
  title?: string;
  given?: Record<string, unknown>;
  when: { trigger?: WhenTrigger; payload?: unknown };
  then?: Then;
}

export interface Suite {
  /** File the suite came from; a synthetic suite names its cases directory. */
  file: string;
  /** Path to the workflow JSON, relative to `file`. */
  workflow: string;
  instance?: string;
  generated?: Record<string, unknown>;
  given?: Record<string, unknown>;
  cases: SuiteCase[];
  /** True when these cases came from `.workflow-tester/cases`, not a written suite. */
  synthetic: boolean;
}

export interface SuiteIssue {
  message: string;
  path: string;
  line?: number;
  column?: number;
}

export class SuiteError extends Error {
  constructor(
    readonly file: string,
    readonly issues: SuiteIssue[],
  ) {
    const where = (i: SuiteIssue): string => (i.line === undefined ? i.path : `${i.path} (line ${i.line})`);
    super(`${file}\n${issues.map((i) => `  ${where(i)}: ${i.message}`).join('\n')}`);
    this.name = 'SuiteError';
  }
}
