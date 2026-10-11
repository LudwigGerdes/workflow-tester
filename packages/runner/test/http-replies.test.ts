import { describe, expect, it } from 'vitest';
import { itemsFromReplies, type ServeReply } from '../src/http-replies.js';

const plan = (over = {}) => ({
  requests: [{ itemIndex: 0, method: 'GET', url: 'https://x.io/a', headers: {} }],
  fullResponse: false,
  neverError: false,
  responseFormat: 'autodetect' as const,
  ...over,
});
const json = (body: unknown, status = 200): ServeReply => ({ status, headers: { 'content-type': 'application/json' }, body });

describe('itemsFromReplies', () => {
  it('a JSON array becomes one item per element, paired to the request item', () => {
    expect(itemsFromReplies(plan(), [json([{ a: 1 }, { a: 2 }])], {}, 1)).toEqual({
      routed: [[{ json: { a: 1 }, pairedItem: { item: 0 } }, { json: { a: 2 }, pairedItem: { item: 0 } }]],
    });
  });

  it('a JSON object is one item; an empty body is {}', () => {
    expect(itemsFromReplies(plan(), [json({ ok: true })], {}, 1)).toEqual({ routed: [[{ json: { ok: true }, pairedItem: { item: 0 } }]] });
    expect(itemsFromReplies(plan(), [json(undefined)], {}, 1)).toEqual({ routed: [[{ json: {}, pairedItem: { item: 0 } }]] });
  });

  it('a non-JSON content type under autodetect becomes { data: text }', () => {
    expect(itemsFromReplies(plan(), [{ status: 200, headers: { 'content-type': 'text/plain' }, body: 'hi' }], {}, 1)).toEqual({
      routed: [[{ json: { data: 'hi' }, pairedItem: { item: 0 } }]],
    });
  });

  it('fullResponse is one item with body, headers, statusCode, statusMessage', () => {
    const out = itemsFromReplies(plan({ fullResponse: true }), [json([1, 2])], {}, 1) as { routed: Array<Array<{ json: Record<string, unknown> }>> };
    expect(out.routed[0]).toHaveLength(1);
    expect(out.routed[0]![0]!.json).toMatchObject({ body: [1, 2], statusCode: 200 });
  });

  it('non-2xx: raised by default, error item on output 0 or the error output when the node continues', () => {
    expect(itemsFromReplies(plan(), [json({}, 503)], {}, 1)).toEqual({ raised: 'the mock answered 503' });
    expect(itemsFromReplies(plan(), [json({}, 503)], { onError: 'continueRegularOutput' }, 1)).toEqual({
      routed: [[{ json: { error: 'the mock answered 503' }, pairedItem: { item: 0 } }]],
    });
    expect(itemsFromReplies(plan(), [json({}, 503)], { onError: 'continueErrorOutput' }, 1)).toEqual({
      routed: [[], [{ json: { error: 'the mock answered 503' }, pairedItem: { item: 0 } }]],
    });
  });

  it('neverError treats a non-2xx reply as a normal answer', () => {
    expect(itemsFromReplies(plan({ neverError: true }), [json({ e: 1 }, 404)], {}, 1)).toEqual({
      routed: [[{ json: { e: 1 }, pairedItem: { item: 0 } }]],
    });
  });
});
