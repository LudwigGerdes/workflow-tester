import { createHash } from 'node:crypto';

/** Canonical JSON: keys sorted at every level, array order preserved. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

/**
 * Content hash used for case ids. Truncated to 16 hex characters: long enough
 * that a collision is not a practical concern across a contract's few hundred
 * cases, short enough to read in a filename and in a failure report.
 */
export function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex').slice(0, 16);
}
