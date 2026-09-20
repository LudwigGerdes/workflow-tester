import { describe, expect, it } from 'vitest';
import type { EngineResult } from 'payload-contract-engine';
import { evaluatePath } from '../src/assert.js';
import { evaluateThen, oracle } from '../src/oracle.js';

describe('evaluatePath', () => {
  it('returns every value a glob names', () => {
    expect(evaluatePath({ a: { x: 1, y: 2 } }, 'a.*')).toEqual([1, 2]);
  });

  it('returns nothing for a missing path', () => {
    expect(evaluatePath({ a: 1 }, 'b.c')).toEqual([]);
  });
});

/** A tier-1 result with the given overrides. */
const result = (overrides: Partial<EngineResult> = {}): EngineResult => ({
  status: 'pass',
  reachedNodes: ['Webhook', 'Extract'],
  outputs: { Extract: [[{ json: { email: 'a@x.io', n: 2 } }, { json: { email: 'b@x.io', n: 3 } }]] },
  failures: [],
  warnings: [],
  boundaries: [],
  substituted: [],
  durationMs: 1,
  ...overrides,
});

describe('evaluateThen', () => {
  it('passes an execution-status expectation that holds', () => {
    const outcome = evaluateThen({ execution: { status: 'success' } }, result());
    expect(outcome.status).toBe('pass');
  });

  it('fails when the run failed but success was expected', () => {
    const failed = result({
      status: 'fail',
      failures: [{ kind: 'required-undefined', node: 'Extract', parameter: 'value', message: 'boom', itemIndex: 0 }],
    });
    const outcome = evaluateThen({ execution: { status: 'success' } }, failed);
    expect(outcome.status).toBe('fail');
    expect(outcome.node).toBe('Extract');
  });

  it('passes when a failure was expected and happened', () => {
    const failed = result({
      status: 'fail',
      failures: [{ kind: 'expression-error', node: 'Extract', parameter: 'value', message: 'boom', itemIndex: 0 }],
    });
    expect(evaluateThen({ execution: { status: 'error' } }, failed).status).toBe('pass');
  });

  it('counts the items a pure node produced', () => {
    expect(evaluateThen({ node: { Extract: { items: 2 } } }, result()).status).toBe('pass');
    const wrong = evaluateThen({ node: { Extract: { items: 5 } } }, result());
    expect(wrong.status).toBe('fail');
    expect(wrong.assertions[0]).toMatchObject({ status: 'fail', expected: 5, actual: 2 });
  });

  it('reads a value out of a named output', () => {
    const outcome = evaluateThen(
      { node: { Extract: { 'output[0].json.email': 'a@x.io' } } },
      result(),
    );
    expect(outcome.status).toBe('pass');
  });

  it('supports a matcher object on an output path', () => {
    const outcome = evaluateThen(
      { node: { Extract: { 'output[0].json.email': { matches: '^a@' } } } },
      result(),
    );
    expect(outcome.status).toBe('pass');
  });

  it('needs a real execution for a node past a boundary', () => {
    const stopped = result({
      status: 'boundary',
      reachedNodes: ['Webhook', 'Extract', 'Call API'],
      boundaries: [{ node: 'Call API', type: 'n8n-nodes-base.httpRequest', reason: 'not-pure', inputItems: [] }],
    });
    const outcome = evaluateThen({ node: { Later: { items: 1 } } }, stopped);
    expect(outcome.status).toBe('needs-execution');
    expect(outcome.assertions[0]?.status).toBe('needs-execution');
  });

  it('still judges a node it did reach, even when the run hit a boundary later', () => {
    const stopped = result({
      status: 'boundary',
      boundaries: [{ node: 'Call API', type: 'n8n-nodes-base.httpRequest', reason: 'not-pure', inputItems: [] }],
    });
    expect(evaluateThen({ node: { Extract: { items: 2 } } }, stopped).status).toBe('pass');
  });

  it('reports execution status as needing a real execution when the run stopped at a boundary', () => {
    const stopped = result({
      status: 'boundary',
      boundaries: [{ node: 'Call API', type: 'n8n-nodes-base.httpRequest', reason: 'not-pure', inputItems: [] }],
    });
    const outcome = evaluateThen({ execution: { status: 'success' } }, stopped);
    expect(outcome.status).toBe('needs-execution');
    // The message names the node, so a reader does not need --format json to
    // learn where the run stopped.
    expect(outcome.message).toMatch(/Call API/);
    expect(outcome.assertions[0]?.message).toMatch(/Call API/);
  });

  it('fails a boundary run outright when it already failed before the boundary', () => {
    const stopped = result({
      status: 'fail',
      failures: [{ kind: 'condition-undefined', node: 'Check', parameter: 'conditions', message: 'undecidable', itemIndex: 0 }],
      boundaries: [{ node: 'Call API', type: 'n8n-nodes-base.httpRequest', reason: 'not-pure', inputItems: [] }],
    });
    expect(evaluateThen({ execution: { status: 'success' } }, stopped).status).toBe('fail');
  });

  it.each([['calls', [{ method: 'POST' }]], ['noUnmatched', true]])(
    'reports %s as needing a real execution',
    (key, value) => {
      const outcome = evaluateThen({ [key]: value } as Record<string, unknown>, result());
      expect(outcome.status).toBe('needs-execution');
    },
  );

  it('passes a case with no expectations at all', () => {
    expect(evaluateThen(undefined, result()).status).toBe('pass');
  });
});

describe('oracle', () => {
  it('passes a clean run', () => {
    expect(oracle(result()).status).toBe('pass');
  });

  it.each(['expression-error', 'required-undefined', 'condition-undefined'] as const)(
    'fails on %s',
    (kind) => {
      const failed = result({
        status: 'fail',
        failures: [{ kind, node: 'Extract', parameter: 'p', message: 'why', itemIndex: 0, resolvedPath: 'body.x' }],
      });
      const outcome = oracle(failed);
      expect(outcome.status).toBe('fail');
      expect(outcome.resolvedPath).toBe('body.x');
      expect(outcome.message).toContain('why');
    },
  );

  it.each(['optional-undefined', 'dead-branch'] as const)('warns on %s', (kind) => {
    const warned = result({ warnings: [{ kind, node: 'Extract', message: 'heads up' }] });
    expect(oracle(warned).status).toBe('warn');
  });

  it('reports a boundary as needing a real execution', () => {
    const stopped = result({
      status: 'boundary',
      boundaries: [{ node: 'Call API', type: 'n8n-nodes-base.httpRequest', reason: 'not-pure', inputItems: [] }],
    });
    const outcome = oracle(stopped);
    expect(outcome.status).toBe('needs-execution');
    expect(outcome.node).toBe('Call API');
  });

  it('prefers a failure over a warning', () => {
    const both = result({
      status: 'fail',
      failures: [{ kind: 'expression-error', node: 'E', parameter: 'p', message: 'bad', itemIndex: 0 }],
      warnings: [{ kind: 'dead-branch', node: 'E', message: 'also this' }],
    });
    expect(oracle(both).status).toBe('fail');
  });
});
