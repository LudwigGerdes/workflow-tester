import { describe, expect, it } from 'vitest';
import { guardsPrefix, inConditionalBranch } from '../src/guard.js';

const P = '$json.body.issue.assignee';

describe('guardsPrefix', () => {
  it('sees a ternary test on the prefix', () => {
    expect(guardsPrefix(`{{ ${P} ? ${P}.login : 'nobody' }}`, P)).toBe(true);
  });

  it('sees a && guard', () => {
    expect(guardsPrefix(`{{ ${P} && ${P}.login }}`, P)).toBe(true);
  });

  it('sees optional chaining on the prefix', () => {
    expect(guardsPrefix(`{{ ${P}?.login }}`, P)).toBe(true);
  });

  it('does not mistake optional chaining for a ternary elsewhere', () => {
    // `?.` is a guard; a bare `?` after the prefix is a ternary. Both count,
    // but neither should be inferred from an unrelated `?` in the expression.
    expect(guardsPrefix(`{{ ${P}.login }}{{ other ? a : b }}`, P)).toBe(false);
  });

  it('reports an unguarded read as unguarded', () => {
    expect(guardsPrefix(`{{ ${P}.login }}`, P)).toBe(false);
  });

  it('does not treat a different prefix as a guard', () => {
    expect(guardsPrefix(`{{ $json.body.issue.milestone ? 1 : 2 }}{{ ${P}.login }}`, P)).toBe(false);
  });
});

describe('inConditionalBranch', () => {
  const A = 'body.issue.assignee';
  const M = 'body.issue.milestone';

  it('sees a read that only happens when a ternary takes that branch', () => {
    // `a ? a.x : b.y` — whether `b.y` runs depends on `a`, so a null `b` on a
    // payload where `a` was present is not a defect, only a possibility.
    expect(inConditionalBranch(`{{ ${A} ? ${A}.login : ${M}.title }}`, M)).toBe(true);
  });

  it('does not call an unconditional read conditional', () => {
    expect(inConditionalBranch(`{{ ${M}.title }}`, M)).toBe(false);
  });

  it('does not treat the guard subject itself as being in a branch', () => {
    expect(inConditionalBranch(`{{ ${A} ? ${A}.login : ${M}.title }}`, A)).toBe(false);
  });

  it('is not fooled by optional chaining', () => {
    expect(inConditionalBranch(`{{ ${A}?.login }}{{ ${M}.title }}`, M)).toBe(false);
  });
});
