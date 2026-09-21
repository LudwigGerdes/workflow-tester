/**
 * The assertion path and matcher language.
 *
 * workflow-test's own matcher language, deliberately self-contained:
 * hand-written tests must work with workflow-test alone, so nothing here may reach for
 * absence must never remove the ability to evaluate an expectation. The two are
 * kept aligned by a shared conformance table both sides run — see
 * `test/matchers.test.ts`.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * `a.b`, `a[0]`, `a.*`, `a[*]`, `a[*].id`
 *
 * The bracket forms are equivalent to the dotted ones — `items[*].ok` and
 * `items.*.ok` name the same values. Both appear in the owner's conformance
 * table, and only supporting the dotted one meant `items[*]` silently matched
 * nothing at all.
 */
function segmentsOf(path: string): string[] {
  return path
    .replace(/\[(\d+|\*)\]/g, '.$1')
    .split('.')
    .filter((segment) => segment.length > 0);
}

/**
 * Every value a path names. A glob or an array walk can name several; a missing
 * path names none, which is what keeps "missing" distinct from "null".
 */
export function evaluatePath(root: unknown, path: string): unknown[] {
  let current: unknown[] = [root];

  for (const segment of segmentsOf(path)) {
    const next: unknown[] = [];
    for (const node of current) {
      if (segment === '*') {
        if (Array.isArray(node)) next.push(...node);
        else if (isRecord(node)) next.push(...Object.values(node));
        continue;
      }
      if (Array.isArray(node)) {
        const index = Number(segment);
        if (Number.isInteger(index) && index >= 0 && index < node.length) next.push(node[index]);
        continue;
      }
      if (isRecord(node) && segment in node) next.push(node[segment]);
    }
    current = next;
  }
  return current;
}

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, i) => deepEqual(entry, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length && keys.every((key) => key in b && deepEqual(a[key], b[key]))
    );
  }
  return false;
};

/** Is every key of `expected` present in `actual`, recursively? */
function isSubset(actual: unknown, expected: unknown): boolean {
  if (isRecord(actual) && isRecord(expected)) {
    return Object.entries(expected).every(
      ([key, value]) => key in actual && isSubset(actual[key], value),
    );
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return expected.every((entry) => actual.some((candidate) => isSubset(candidate, entry)));
  }
  return deepEqual(actual, expected);
}

export const MATCHERS = ['equals', 'contains', 'matches', 'count', 'gte', 'lte'] as const;
export type Matcher = (typeof MATCHERS)[number];

export const isMatcher = (value: string): value is Matcher => (MATCHERS as readonly string[]).includes(value);

/** Apply one matcher to the values a path named. */
function apply(matcher: string, expected: unknown, found: unknown[]): boolean {
  // `count` is about how many values there are, so it is the one matcher that
  // is meaningful when the path named nothing.
  if (matcher === 'count') {
    if (found.length === 1) {
      const [only] = found;
      if (Array.isArray(only)) return only.length === expected;
      if (typeof only === 'string') return only.length === expected;
    }
    return found.length === expected;
  }

  // Everything else needs at least one value: a path that named nothing cannot
  // satisfy an expectation, and must not vacuously pass.
  if (found.length === 0) return false;

  return found.every((value) => {
    switch (matcher) {
      case 'contains':
        if (typeof value === 'string') return typeof expected === 'string' && value.includes(expected);
        if (Array.isArray(value)) return value.some((entry) => deepEqual(entry, expected));
        // On an object, `contains` is a deep subset: the keys named must match,
        // and any others are ignored. That lets an assertion pin the part of a
        // payload it cares about without restating the whole of it.
        if (isRecord(value)) return isSubset(value, expected);
        return false;
      case 'matches':
        return typeof value === 'string' && typeof expected === 'string' && new RegExp(expected).test(value);
      case 'gte':
        return typeof value === 'number' && typeof expected === 'number' && value >= expected;
      case 'lte':
        return typeof value === 'number' && typeof expected === 'number' && value <= expected;
      case 'equals':
      default:
        return deepEqual(value, expected);
    }
  });
}

/** Does `root` satisfy `expected` at `path` under `matcher`? */
export function matches(root: unknown, path: string, matcher: string, expected: unknown): boolean {
  return apply(matcher, expected, evaluatePath(root, path));
}

/**
 * An expectation written either bare (`items: 2`, meaning equals) or as a
 * matcher object (`{ matches: '^inv_' }`).
 */
export function readExpectation(value: unknown): { matcher: string; expected: unknown } {
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([key]) => isMatcher(key));
    const [first] = entries;
    if (entries.length === 1 && first !== undefined) {
      return { matcher: first[0], expected: first[1] };
    }
  }
  return { matcher: 'equals', expected: value };
}
