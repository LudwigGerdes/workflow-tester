import type { Shape } from 'workflow-tester-contracts';
import { renderChain, type Chain } from './chain.js';

export type FindingKind = 'container-mismatch' | 'index-out-of-range' | 'absent-field';

export interface Finding {
  kind: FindingKind;
  /**
   * `warn` is for an inference that is real but unsound — an optional field, or
   * an index bound observed from a finite number of runs. Reporting an unsound
   * inference as sound is worse than reporting it honestly.
   */
  severity: 'fail' | 'warn';
  /** The chain prefix the problem is at, e.g. `items[0].sku`. */
  at: string;
  message: string;
}

const article = (type: Shape['type']): string =>
  type === 'array' || type === 'object' ? `an ${type}` : `a ${type}`;

/**
 * Walk an access chain against the shape the data actually had.
 *
 * The walk stops at the first failure. A chain that read a field off an array
 * has already left the shape behind, and every finding after that point would
 * be a consequence of the first rather than a defect of its own.
 */
export function checkChain(shape: Shape, chain: Chain): Finding[] {
  const findings: Finding[] = [];
  let cursor: Shape = shape;

  for (let i = 0; i < chain.length; i += 1) {
    const segment = chain[i];
    if (segment === undefined) break;
    const at = renderChain(chain.slice(0, i + 1));

    // Nothing is known here, so nothing can be claimed.
    if (cursor.type === 'unknown') return findings;

    if (segment.kind === 'field') {
      if (cursor.type !== 'object') {
        findings.push({
          kind: 'container-mismatch',
          severity: 'fail',
          at: renderChain(chain.slice(0, i)),
          message: `read field "${segment.name}" on ${article(cursor.type)}`,
        });
        return findings;
      }
      const next = cursor.fields?.[segment.name];
      if (next === undefined) {
        findings.push({
          kind: 'absent-field',
          // A warning, not a failure, and deliberately so. n8n yields undefined
          // for a path that is not there, and the established contract is that
          // a value resolving to nothing warns — `--fail-on warn` is how you
          // tighten it. Two things depend on that: a `??` fallback reads a path
          // that is absent by design on every payload it does not match, and a
          // suite that fails on every legitimate edit gets regenerated unread.
          severity: 'warn',
          at,
          message: `"${segment.name}" is not produced here`,
        });
        return findings;
      }
      if (next.optional === true) {
        findings.push({
          kind: 'absent-field',
          severity: 'warn',
          at,
          message: `"${segment.name}" is not present on every item`,
        });
      }
      cursor = next;
      continue;
    }

    if (cursor.type !== 'array') {
      findings.push({
        kind: 'container-mismatch',
        severity: 'fail',
        at: renderChain(chain.slice(0, i)),
        message: `indexed ${article(cursor.type)}`,
      });
      return findings;
    }

    const bound = cursor.cardinality;
    if (bound !== undefined && segment.index >= bound.max) {
      findings.push({
        kind: 'index-out-of-range',
        // Unsound by construction: an array of five in every run observed says
        // nothing conclusive about the next one. Real signal, honest severity.
        severity: 'warn',
        at,
        message: `index ${segment.index} on an array that held at most ${bound.max}`,
      });
    }

    const items = cursor.items;
    if (items === undefined) return findings; // an array only ever seen empty
    cursor = items;
  }

  return findings;
}
