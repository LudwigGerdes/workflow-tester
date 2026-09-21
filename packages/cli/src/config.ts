import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Io } from './io.js';

/**
 * What this repository records about itself.
 *
 * The n8n version lives here rather than in an environment variable because it
 * describes the workflows in this repository: it is the same for everyone who
 * clones it, and it belongs in git beside them. `WORKFLOW_TESTER_MODE` is the opposite —
 * it describes where you are working, so a committed value would claim one
 * environment and be wrong for the other. Same reasoning, opposite conclusion.
 */
export interface Config {
  n8nVersion?: string;
}

export function configPath(cwd: string): string {
  return join(cwd, '.workflow-tester', 'config.yaml');
}

/**
 * Read it, or carry on without it.
 *
 * Every failure is silent and empty: a missing or malformed config must not
 * stop a run, because the bundled descriptions work regardless. Being wrong
 * about the version costs a warning, never a blocked test suite.
 */
export function readConfig(io: Io): Config {
  const file = configPath(io.cwd);
  if (!existsSync(file)) return {};
  try {
    const parsed = parse(readFileSync(file, 'utf8')) as { n8nVersion?: unknown } | null;
    const version = parsed?.n8nVersion;
    if (typeof version !== 'string' || !/^\d+\.\d+/.test(version.trim())) return {};
    return { n8nVersion: version.trim() };
  } catch {
    return {};
  }
}
