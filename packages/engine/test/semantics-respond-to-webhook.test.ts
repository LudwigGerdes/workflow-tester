import { describe, expect, it } from 'vitest';
import { isPureType, semanticsFor } from '../src/semantics/index.js';
import { UnsupportedModeError } from '../src/types.js';
import { items, runSemantics } from './helpers.js';

const RESPOND = 'n8n-nodes-base.respondToWebhook';

/**
 * Respond to Webhook sends the HTTP response as a side effect and hands its
 * input on unchanged — n8n's `execute` ends in `return [items]`. The response
 * itself is deterministic from the parameters, so the node is interpreted
 * rather than treated as a boundary: a webhook workflow that ends in one is
 * verified to its end.
 */
describe('Respond to Webhook semantics', () => {
  it('is interpreted from v1', () => {
    expect(isPureType(RESPOND)).toBe(true);
    expect(semanticsFor(RESPOND, 1)).toBeDefined();
    expect(semanticsFor(RESPOND, 1.5)).toBeDefined();
  });

  it('passes every input item through, re-paired by index', () => {
    const { outputs } = runSemantics(
      RESPOND,
      1.1,
      { respondWith: 'firstIncomingItem', options: {} },
      items({ a: 1 }, { a: 2 }),
    );
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.map((item) => item.json)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(outputs[0]?.map((item) => item.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
  });

  it('adds the response output at v1.3', () => {
    const { outputs } = runSemantics(
      RESPOND,
      1.3,
      { respondWith: 'firstIncomingItem', options: {} },
      items({ a: 1 }, { a: 2 }),
    );
    expect(outputs).toHaveLength(2);
    expect(outputs[0]?.map((item) => item.json)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(outputs[1]?.[0]?.json).toEqual({
      response: { statusCode: 200, headers: {}, body: { a: 1 } },
    });
  });

  it('adds the response output from v1.4 only when enableResponseOutput is set', () => {
    const on = runSemantics(
      RESPOND,
      1.4,
      { enableResponseOutput: true, respondWith: 'allIncomingItems', options: {} },
      items({ a: 1 }, { a: 2 }),
    );
    expect(on.outputs).toHaveLength(2);
    expect(on.outputs[1]?.[0]?.json).toEqual({
      response: { statusCode: 200, headers: {}, body: [{ a: 1 }, { a: 2 }] },
    });

    const off = runSemantics(
      RESPOND,
      1.4,
      { enableResponseOutput: false, respondWith: 'allIncomingItems', options: {} },
      items({ a: 1 }),
    );
    expect(off.outputs).toHaveLength(1);
  });

  it('builds the body the way n8n does for each respondWith', () => {
    const body = (params: Record<string, unknown>) =>
      (
        runSemantics(RESPOND, 1.3, { options: {}, ...params }, items({ a: 1 }, { a: 2 })).outputs[1]?.[0]
          ?.json as { response: { body: unknown; statusCode: number; headers: Record<string, unknown> } }
      ).response;

    expect(body({ respondWith: 'json', responseBody: '{"ok": true}' }).body).toEqual({ ok: true });
    expect(body({ respondWith: 'json', responseBody: { ok: 1 } }).body).toEqual({ ok: 1 });
    expect(body({ respondWith: 'text', responseBody: 'done' }).body).toBe('done');
    expect(body({ respondWith: 'noData' }).body).toBeUndefined();
    expect(body({ respondWith: 'firstIncomingItem', options: { responseKey: 'data' } }).body).toEqual({
      data: { a: 1 },
    });
    expect(body({ respondWith: 'allIncomingItems', options: { responseKey: 'rows' } }).body).toEqual({
      rows: [{ a: 1 }, { a: 2 }],
    });
    const redirect = body({ respondWith: 'redirect', redirectURL: 'https://x.io/' });
    expect(redirect.statusCode).toBe(307);
    expect(redirect.headers).toEqual({ location: 'https://x.io/' });
  });

  it('honours the response code and header options', () => {
    const { outputs } = runSemantics(
      RESPOND,
      1.3,
      {
        respondWith: 'noData',
        options: {
          responseCode: 202,
          responseHeaders: { entries: [{ name: 'X-Trace', value: 'abc' }] },
        },
      },
      items({ a: 1 }),
    );
    expect(outputs[1]?.[0]?.json).toEqual({
      response: { statusCode: 202, headers: { 'x-trace': 'abc' }, body: undefined },
    });
  });

  it('ends the path as a boundary when the response needs a credential', () => {
    expect(() =>
      runSemantics(RESPOND, 1.3, { respondWith: 'jwt', payload: '{}', options: {} }, items({ a: 1 })),
    ).toThrow(UnsupportedModeError);
  });
});
