import { describe, expect, it } from 'vitest';
import { items, runSemantics } from './helpers.js';
import { UnsupportedModeError } from '../src/types.js';

const run = (params: Record<string, unknown>, input = items({ a: 1, b: 2 })) =>
  runSemantics('n8n-nodes-base.renameKeys', 1, params, input);

const keys = (...pairs: Array<[string, string]>) => ({
  keys: { key: pairs.map(([currentKey, newKey]) => ({ currentKey, newKey })) },
});

describe('Rename Keys semantics', () => {
  it('renames a key, removing the old one', () => {
    const { outputs } = run(keys(['a', 'alpha']));
    expect(outputs[0]?.[0]?.json).toEqual({ alpha: 1, b: 2 });
  });

  it('renames several keys in one pass', () => {
    const { outputs } = run(keys(['a', 'alpha'], ['b', 'beta']));
    expect(outputs[0]?.[0]?.json).toEqual({ alpha: 1, beta: 2 });
  });

  it('leaves a key that is not there alone', () => {
    const { outputs } = run(keys(['nope', 'x']));
    expect(outputs[0]?.[0]?.json).toEqual({ a: 1, b: 2 });
  });

  it('ignores blank rename entries', () => {
    const { outputs } = run({ keys: { key: [{ currentKey: '', newKey: '' }] } });
    expect(outputs[0]?.[0]?.json).toEqual({ a: 1, b: 2 });
  });

  it('reads and writes dotted names', () => {
    const { outputs } = run(keys(['user.name', 'who']), items({ user: { name: 'Ada' } }));
    expect(outputs[0]?.[0]?.json).toEqual({ user: { name: 'Ada' }, who: 'Ada' });
  });

  it('keeps paired items', () => {
    const { outputs } = run(keys(['a', 'alpha']), items({ a: 1 }, { a: 2 }));
    expect(outputs[0]?.map((o) => o.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
  });

  it('treats regex replacement as a boundary', () => {
    expect(() => run({ ...keys(['a', 'b']), additionalOptions: { regexReplacement: {} } })).toThrow(
      UnsupportedModeError,
    );
  });
});
