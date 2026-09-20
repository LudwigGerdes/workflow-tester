import { describe, expect, it } from 'vitest';
import type { INode, INodeExecutionData } from 'n8n-workflow';
import { semanticsFor, isPureType } from '../src/semantics/index.js';
import { ConditionEvaluationError } from '../src/types.js';
import type { SemanticsContext } from '../src/types.js';

const node = (name: string, type: string, typeVersion: number): INode => ({
  parameters: {},
  id: name,
  name,
  type,
  typeVersion,
  position: [0, 0],
});

/** Run a node kind's semantics over hand-built resolved parameters. */
const run = (
  type: string,
  typeVersion: number,
  params: Record<string, unknown> | ((i: number) => Record<string, unknown>),
  input: INodeExecutionData[],
) => {
  const semantics = semanticsFor(type, typeVersion);
  if (semantics === undefined) throw new Error(`no semantics for ${type}@${typeVersion}`);
  const ctx: SemanticsContext = {
    node: node('N', type, typeVersion),
    inputs: [input],
    resolve: (i) => (typeof params === 'function' ? params(i) : params),
  };
  return semantics(ctx, input);
};

const items = (...jsons: Array<Record<string, unknown>>): INodeExecutionData[] =>
  jsons.map((json, item) => ({ json, pairedItem: { item } }));

const assignment = (name: string, value: unknown, type = 'string') => ({
  id: name,
  name,
  value,
  type,
});

const SET = 'n8n-nodes-base.set';
const IF = 'n8n-nodes-base.if';
const FILTER = 'n8n-nodes-base.filter';
const NOOP = 'n8n-nodes-base.noOp';

describe('Set semantics', () => {
  it('drops other fields unless includeOtherFields is set', () => {
    const { outputs } = run(
      SET,
      3.4,
      { mode: 'manual', includeOtherFields: false, assignments: { assignments: [assignment('email', 'a@x.io')] }, options: {} },
      items({ keep: 'me' }),
    );
    expect(outputs[0]?.[0]?.json).toEqual({ email: 'a@x.io' });
  });

  it('keeps other fields when includeOtherFields is set', () => {
    const { outputs } = run(
      SET,
      3.4,
      { mode: 'manual', includeOtherFields: true, assignments: { assignments: [assignment('email', 'a@x.io')] }, options: {} },
      items({ keep: 'me' }),
    );
    expect(outputs[0]?.[0]?.json).toEqual({ keep: 'me', email: 'a@x.io' });
  });

  it('nests dotted assignment names', () => {
    const { outputs } = run(
      SET,
      3.4,
      { mode: 'manual', includeOtherFields: false, assignments: { assignments: [assignment('user.contact.email', 'a@x.io')] }, options: {} },
      items({}),
    );
    expect(outputs[0]?.[0]?.json).toEqual({ user: { contact: { email: 'a@x.io' } } });
  });

  it('writes a literal dotted key when dotNotation is disabled', () => {
    const { outputs } = run(
      SET,
      3.4,
      { mode: 'manual', includeOtherFields: false, assignments: { assignments: [assignment('a.b', 1, 'number')] }, options: { dotNotation: false } },
      items({}),
    );
    expect(outputs[0]?.[0]?.json).toEqual({ 'a.b': 1 });
  });

  it.each([
    ['number', '42', 42],
    ['boolean', 'true', true],
    ['boolean', 'false', false],
    ['string', 42, '42'],
    ['array', '[1,2]', [1, 2]],
    ['object', '{"a":1}', { a: 1 }],
  ])('coerces %s assignments', (type, value, expected) => {
    const { outputs } = run(
      SET,
      3.4,
      { mode: 'manual', includeOtherFields: false, assignments: { assignments: [assignment('v', value, type)] }, options: {} },
      items({}),
    );
    expect(outputs[0]?.[0]?.json.v).toEqual(expected);
  });

  it('takes the whole object from jsonOutput in raw mode', () => {
    const { outputs } = run(
      SET,
      3.4,
      { mode: 'raw', jsonOutput: '{"a":1}', options: {} },
      items({ ignored: true }),
    );
    expect(outputs[0]?.[0]?.json).toEqual({ a: 1 });
  });

  it('warns when an assignment resolves undefined and leaves the key undefined', () => {
    const { outputs, warnings } = run(
      SET,
      3.4,
      { mode: 'manual', includeOtherFields: false, assignments: { assignments: [assignment('email', undefined)] }, options: {} },
      items({}),
    );
    expect(warnings).toEqual([
      expect.objectContaining({ kind: 'optional-undefined', node: 'N', parameter: 'assignments.email', itemIndex: 0 }),
    ]);
    expect(outputs[0]?.[0]?.json).toHaveProperty('email', undefined);
  });

  it('pairs each output item with its input index', () => {
    const { outputs } = run(
      SET,
      3.4,
      (i) => ({ mode: 'manual', includeOtherFields: false, assignments: { assignments: [assignment('i', String(i))] }, options: {} }),
      items({}, {}, {}),
    );
    expect(outputs[0]?.map((o) => o.pairedItem)).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
  });
});

const stringCondition = (leftValue: unknown, operation = 'notEmpty', typeValidation = 'strict') => ({
  options: { caseSensitive: true, leftValue: '', typeValidation, version: 2 },
  conditions: [
    { id: 'c1', leftValue, rightValue: '', operator: { type: 'string', operation, singleValue: true } },
  ],
  combinator: 'and',
});

describe('IF semantics', () => {
  it('routes matching items to output 0 and the rest to output 1', () => {
    const { outputs } = run(
      IF,
      2.2,
      (i) => ({ conditions: stringCondition(i === 0 ? 'yes' : ''), options: {} }),
      items({ n: 0 }, { n: 1 }),
    );
    expect(outputs[0]?.map((o) => o.json)).toEqual([{ n: 0 }]);
    expect(outputs[1]?.map((o) => o.json)).toEqual([{ n: 1 }]);
  });

  it('keeps paired items pointing at the input index', () => {
    const { outputs } = run(
      IF,
      2.2,
      (i) => ({ conditions: stringCondition(i === 1 ? 'yes' : ''), options: {} }),
      items({ n: 0 }, { n: 1 }),
    );
    expect(outputs[0]?.[0]?.pairedItem).toEqual({ item: 1 });
    expect(outputs[1]?.[0]?.pairedItem).toEqual({ item: 0 });
  });

  it('always returns both branches, empty when nothing matched', () => {
    const { outputs } = run(IF, 2.2, { conditions: stringCondition('x'), options: {} }, items({}));
    expect(outputs).toHaveLength(2);
    expect(outputs[1]).toEqual([]);
  });

  it('allows an undefined operand for existence operators', () => {
    const { outputs } = run(
      IF,
      2.2,
      { conditions: stringCondition(undefined, 'notEmpty'), options: {} },
      items({}),
    );
    // notEmpty is *about* presence: undefined is a legitimate answer (false),
    // not an undecidable comparison.
    expect(outputs[0]).toEqual([]);
    expect(outputs[1]).toHaveLength(1);
  });

  it('reports a type mismatch raised by n8n as a condition error', () => {
    expect(() =>
      run(
        IF,
        2.2,
        { conditions: stringCondition(5, 'equals'), options: {} },
        items({}),
      ),
    ).toThrow(ConditionEvaluationError);
  });

  it('reports a strict-mode comparison against undefined as a condition error', () => {
    expect(() =>
      run(
        IF,
        2.2,
        {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [
              { id: 'c1', leftValue: undefined, rightValue: 5, operator: { type: 'number', operation: 'gt' } },
            ],
            combinator: 'and',
          },
          options: {},
        },
        items({}),
      ),
    ).toThrow(ConditionEvaluationError);
  });
});

describe('Filter semantics', () => {
  // Both outputs are always produced. This was originally written the other way
  // round — a single output, with the second appearing only under
  // `keepDiscardedItems` — and a captured execution showed n8n does not behave
  // that way. The fixture is the authority.
  it('keeps matching items on output 0 and discards to output 1', () => {
    const { outputs } = run(
      FILTER,
      2.2,
      (i) => ({ conditions: stringCondition(i === 0 ? 'yes' : ''), options: {} }),
      items({ n: 0 }, { n: 1 }),
    );
    expect(outputs).toHaveLength(2);
    expect(outputs[0]?.map((o) => o.json)).toEqual([{ n: 0 }]);
    expect(outputs[1]?.map((o) => o.json)).toEqual([{ n: 1 }]);
  });

  it('still produces both outputs when nothing is discarded', () => {
    const { outputs } = run(
      FILTER,
      2.2,
      { conditions: stringCondition('yes'), options: {} },
      items({ n: 0 }),
    );
    expect(outputs).toHaveLength(2);
    expect(outputs[1]).toEqual([]);
  });

  it('pairs each item back to its input index', () => {
    const { outputs } = run(
      FILTER,
      2.2,
      (i) => ({ conditions: stringCondition(i === 1 ? 'yes' : ''), options: {} }),
      items({ n: 0 }, { n: 1 }),
    );
    expect(outputs[0]?.[0]?.pairedItem).toEqual({ item: 1 });
    expect(outputs[1]?.[0]?.pairedItem).toEqual({ item: 0 });
  });
});

describe('NoOp semantics', () => {
  it('passes items through untouched', () => {
    const input = items({ a: 1 }, { b: 2 });
    const { outputs } = run(NOOP, 1, {}, input);
    expect(outputs[0]?.map((o) => o.json)).toEqual([{ a: 1 }, { b: 2 }]);
    expect(outputs[0]?.map((o) => o.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
  });
});

describe('registry', () => {
  it('has no semantics for a non-pure node', () => {
    expect(semanticsFor('n8n-nodes-base.httpRequest', 4.2)).toBeUndefined();
    expect(isPureType('n8n-nodes-base.httpRequest')).toBe(false);
  });

  it('has no semantics for a pure type at an unsupported version', () => {
    expect(semanticsFor(SET, 2)).toBeUndefined();
    expect(semanticsFor(IF, 1)).toBeUndefined();
    // but the type itself is one we interpret — the walker uses this to say
    // "unsupported-mode" rather than "not-pure"
    expect(isPureType(SET)).toBe(true);
  });

  it('supports the phase-0 pure set', () => {
    expect(semanticsFor(SET, 3.4)).toBeDefined();
    expect(semanticsFor(IF, 2.2)).toBeDefined();
    expect(semanticsFor(FILTER, 2.2)).toBeDefined();
    expect(semanticsFor(NOOP, 1)).toBeDefined();
  });
});
