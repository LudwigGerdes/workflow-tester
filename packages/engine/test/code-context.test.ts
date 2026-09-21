import type { IWorkflowDataProxyData } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { buildCodeContext } from '../src/semantics/code-context.js';
import { ImpureCallError } from '../src/types.js';

const items = [{ json: { a: 1 } }, { json: { a: 2 } }];

/**
 * Stands in for what n8n's own data proxy hands back. Only the members these
 * tests read are present; the point is that the context passes the proxy's
 * members through untouched rather than reimplementing them.
 */
const proxy = {
  $input: { all: () => items, first: () => items[0], last: () => items[1] },
  $json: { a: 1 },
  $node: { name: 'Code' },
  $prevNode: { name: 'Webhook' },
  $execution: { id: 'workflow-test' },
  $vars: {},
} as unknown as IWorkflowDataProxyData;

const base = { node: 'Code', proxy, seed: 'case-1' };

describe('buildCodeContext', () => {
  it('passes the proxy members through rather than reimplementing them', () => {
    const { context } = buildCodeContext(base);
    expect((context['$input'] as { all(): unknown[] }).all()).toEqual(items);
    expect(context['$json']).toEqual({ a: 1 });
    expect(context['$prevNode']).toEqual({ name: 'Webhook' });
    expect(context['$execution']).toEqual({ id: 'workflow-test' });
  });

  it('throws ImpureCallError from $getWorkflowStaticData', () => {
    const { context } = buildCodeContext(base);
    const call = context['$getWorkflowStaticData'] as (s: string) => unknown;
    expect(() => call('global')).toThrow(ImpureCallError);
  });

  it('throws ImpureCallError from the HTTP helper, naming the call', () => {
    const { context } = buildCodeContext(base);
    const helpers = context['$helpers'] as { httpRequest(o: unknown): unknown };
    try {
      helpers.httpRequest({});
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ImpureCallError);
      expect((error as ImpureCallError).call).toBe('$helpers.httpRequest');
    }
  });

  it('collects console output rather than discarding it', () => {
    const { context, logs } = buildCodeContext(base);
    const console_ = context['console'] as { log(...a: unknown[]): void };
    console_.log('hello', 42);
    expect(logs).toEqual(['hello 42']);
  });

  it('is deterministic for a given seed', () => {
    const a = buildCodeContext(base).context['Math'] as { random(): number };
    const b = buildCodeContext(base).context['Math'] as { random(): number };
    expect(a.random()).toBe(b.random());
  });

  it('differs across seeds', () => {
    const a = buildCodeContext(base).context['Math'] as { random(): number };
    const b = buildCodeContext({ ...base, seed: 'case-2' }).context['Math'] as {
      random(): number;
    };
    expect(a.random()).not.toBe(b.random());
  });

  it('freezes the clock, so a case does not depend on when it ran', () => {
    const now = buildCodeContext(base).context['Date'] as { now(): number };
    expect(now.now()).toBe(0);
  });

  // Real Code nodes overwhelmingly write `new Date()`, not `Date.now()`.
  it('keeps Date constructible', () => {
    const D = buildCodeContext(base).context['Date'] as DateConstructor;
    expect(new D()).toBeInstanceOf(Date);
    expect(new D().getTime()).toBe(0);
  });

  it('still parses an explicit date, which must not be frozen', () => {
    const D = buildCodeContext(base).context['Date'] as DateConstructor;
    expect(new D('2020-01-02T03:04:05Z').toISOString()).toBe('2020-01-02T03:04:05.000Z');
  });

  it('keeps Math usable beyond random', () => {
    const M = buildCodeContext(base).context['Math'] as Math;
    expect(M.floor(1.9)).toBe(1);
    expect(M.max(1, 5)).toBe(5);
  });
});
