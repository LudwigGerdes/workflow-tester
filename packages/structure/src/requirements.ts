import { renderChain, type Chain } from './chain.js';

/** One thing a chain asserts about the data, by the act of reading it. */
export interface Requirement {
  /** The chain prefix the requirement applies to; `(root)` for the item itself. */
  at: string;
  kind: 'has-field' | 'min-length';
  /** The field name, or the minimum element count as a decimal string. */
  detail: string;
}

/**
 * What a chain requires of the data, read off the expression alone.
 *
 * These are never asserted on their own. The list a real chain produces is long
 * and each entry is individually near-worthless — "are there always 58 items?"
 * is not a test anyone wants to read. They are held for diagnosis: when
 * something downstream breaks, this is what names which link gave way.
 */
export function impliedRequirements(chain: Chain): Requirement[] {
  return chain.map((segment, i) => {
    const prefix = i === 0 ? '(root)' : renderChain(chain.slice(0, i));
    return segment.kind === 'field'
      ? { at: prefix, kind: 'has-field' as const, detail: segment.name }
      : { at: prefix, kind: 'min-length' as const, detail: String(segment.index + 1) };
  });
}
