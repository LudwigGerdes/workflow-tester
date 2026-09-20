/**
 * Does this expression guard reads below `prefix`?
 *
 * `a ? a.b : c`, `a && a.b` and `a?.b` all say the same thing: the author knows
 * `a` may be missing and has handled it. Reporting a null there reports the
 * guard doing its job, and a checker that cries wolf on correct code is one
 * people learn to ignore.
 *
 * Deliberately three idioms and no parser. It recognises the forms people
 * actually write; anything subtler — `a !== null ? …`, a guard in an enclosing
 * `if` — still reports, which errs toward a false alarm rather than silence.
 */
export function guardsPrefix(expression: string, prefix: string): boolean {
  if (prefix === '') return false;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    // `a?.b` — optional chaining on the prefix itself.
    new RegExp(`${escaped}\\s*\\?\\.`).test(expression) ||
    // `a ? … : …` — a ternary test. `(?!\\.)` keeps `?.` out of this branch.
    new RegExp(`${escaped}\\s*\\?(?!\\.)`).test(expression) ||
    // `a && a.b`
    new RegExp(`${escaped}\\s*&&`).test(expression)
  );
}

/**
 * Does this read only happen when a conditional takes that branch?
 *
 * In `a ? a.x : b.y`, whether `b.y` runs depends on `a`. A null `b` on a
 * payload where `a` was present is a possibility, not a defect — and this
 * package's rule is that an unsound inference is reported honestly rather than
 * as sound. Callers downgrade such a finding to a warning: still said, not
 * claimed as certain.
 *
 * Heuristic, like the guards above: a ternary `?` before the read inside the
 * same `{{ }}` segment. `?.` is not a ternary and does not count.
 */
export function inConditionalBranch(expression: string, prefix: string): boolean {
  if (prefix === '') return false;
  for (const segment of expression.split('{{')) {
    const at = segment.indexOf(prefix);
    if (at === -1) continue;
    const before = segment.slice(0, at);
    // Ternary `?` only: skip optional chaining and the `??` operator.
    const ternaries = before.replace(/\?\./g, '').replace(/\?\?/g, '').match(/\?/g);
    if (ternaries !== null && ternaries.length > 0) return true;
  }
  return false;
}
