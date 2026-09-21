import { describe, expect, it } from 'vitest';
import type { INode } from 'n8n-workflow';
import { wrapWebhook, wrapWebhookSchema } from '../src/envelope.js';

const webhookNode = (parameters: Record<string, unknown> = {}): INode => ({
  parameters: { httpMethod: 'POST', path: 'x', options: {}, ...parameters },
  id: 'n1',
  name: 'Webhook',
  type: 'n8n-nodes-base.webhook',
  typeVersion: 2,
  position: [0, 0],
});

describe('wrapWebhook', () => {
  it('produces the four-part item an n8n Webhook node emits', () => {
    const item = wrapWebhook({ hello: 'world' }, { vendor: 'stripe', node: webhookNode() });
    expect(Object.keys(item).sort()).toEqual(['body', 'headers', 'params', 'query']);
    expect(item.body).toEqual({ hello: 'world' });
    expect(item.params).toEqual({});
    expect(item.query).toEqual({});
  });

  it('sets the GitHub event header from the event name', () => {
    const item = wrapWebhook({}, { vendor: 'github', event: 'pull_request', node: webhookNode() });
    expect(item.headers['x-github-event']).toBe('pull_request');
    expect(item.headers['x-github-delivery']).toBeDefined();
    expect(item.headers['x-hub-signature-256']).toMatch(/^sha256=/);
  });

  it('sets Stripe and Slack signature headers', () => {
    expect(wrapWebhook({}, { vendor: 'stripe', node: webhookNode() }).headers['stripe-signature']).toMatch(
      /^t=\d+,v1=/,
    );
    const slack = wrapWebhook({}, { vendor: 'slack', node: webhookNode() }).headers;
    expect(slack['x-slack-signature']).toMatch(/^v0=/);
    expect(slack['x-slack-request-timestamp']).toBeDefined();
  });

  it('is deterministic: the same input yields the same envelope', () => {
    const a = wrapWebhook({ n: 1 }, { vendor: 'github', event: 'push', node: webhookNode() });
    const b = wrapWebhook({ n: 1 }, { vendor: 'github', event: 'push', node: webhookNode() });
    expect(a).toEqual(b);
  });

  it('always sends content-type json', () => {
    const item = wrapWebhook({}, { vendor: 'github', node: webhookNode() });
    expect(item.headers['content-type']).toBe('application/json');
  });
});

describe('wrapWebhookSchema', () => {
  it('places the vendor schema under properties.body', () => {
    const wrapped = wrapWebhookSchema(
      { type: 'object', properties: { id: { type: 'string' } } },
      { vendor: 'stripe' },
    ) as { properties: { body: unknown; headers: { type: string } } };
    expect(wrapped.properties.body).toEqual({ type: 'object', properties: { id: { type: 'string' } } });
    expect(wrapped.properties.headers.type).toBe('object');
  });

  it('turns each oneOf branch into its own envelope', () => {
    const wrapped = wrapWebhookSchema(
      {
        oneOf: [
          { type: 'object', 'x-workflow-test-event': 'push', 'x-workflow-test-event-header': 'push' },
          { type: 'object', 'x-workflow-test-event': 'pull-request-opened', 'x-workflow-test-event-header': 'pull_request' },
        ],
      },
      { vendor: 'github' },
    ) as { oneOf: Array<{ properties: { headers: { properties: Record<string, { const?: string }> } }; 'x-workflow-test-event': string }> };

    expect(wrapped.oneOf).toHaveLength(2);
    // GitHub discriminates by header, so that is where the const has to land
    expect(wrapped.oneOf[0]?.properties.headers.properties['x-github-event']?.const).toBe('push');
    expect(wrapped.oneOf[1]?.properties.headers.properties['x-github-event']?.const).toBe('pull_request');
    expect(wrapped.oneOf[1]?.['x-workflow-test-event']).toBe('pull-request-opened');
  });

  it('does not leave workflow-test annotations inside the body schema', () => {
    const wrapped = wrapWebhookSchema(
      { oneOf: [{ type: 'object', 'x-workflow-test-event': 'push', 'x-workflow-test-event-header': 'push' }] },
      { vendor: 'github' },
    ) as { oneOf: Array<{ properties: { body: Record<string, unknown> } }> };
    expect(wrapped.oneOf[0]?.properties.body).not.toHaveProperty('x-workflow-test-event');
    expect(wrapped.oneOf[0]?.properties.body).not.toHaveProperty('x-workflow-test-event-header');
  });

  it('keeps focus-set paths lining up with expressions', () => {
    // a workflow reads `$json.body.data.object.id`; the wrapped schema must have
    // that exact path so the generator's focus set matches
    const wrapped = wrapWebhookSchema(
      { type: 'object', properties: { data: { type: 'object', properties: { object: { type: 'object', properties: { id: { type: 'string' } } } } } } },
      { vendor: 'stripe' },
    ) as { properties: { body: { properties: { data: { properties: { object: { properties: { id: unknown } } } } } } } };
    expect(wrapped.properties.body.properties.data.properties.object.properties.id).toEqual({
      type: 'string',
    });
  });
});
