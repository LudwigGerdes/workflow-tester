import type { INode } from 'n8n-workflow';
import { EVENT_HEADER_KEY, EVENT_KEY } from './materialize.js';

/** The item json an n8n Webhook node hands downstream. */
export interface WebhookItem {
  headers: Record<string, string>;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export interface EnvelopeOptions {
  vendor: string;
  /** The value the vendor sends in its event header, when it uses one. */
  event?: string;
  node?: INode;
}

/**
 * Per-vendor request headers.
 *
 * Signature values are fixed placeholders, never real signatures: workflow-tester has no
 * webhook secret and signing one would be meaningless. A workflow that verifies
 * a signature is therefore a tier-2 concern — the mock has to stand in for the
 * verifying call. What matters at tier 1 is that the *shape* is right, so
 * `$json.headers['x-github-event']` resolves as it would in production.
 */
const VENDOR_HEADERS: Record<string, (event?: string) => Record<string, string>> = {
  github: (event) => ({
    'x-github-event': event ?? 'ping',
    'x-github-delivery': '00000000-0000-4000-8000-000000000000',
    'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
    'user-agent': 'GitHub-Hookshot/workflow-tester',
  }),
  stripe: () => ({
    'stripe-signature': `t=1700000000,v1=${'0'.repeat(64)}`,
    'user-agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)',
  }),
  slack: () => ({
    'x-slack-signature': `v0=${'0'.repeat(64)}`,
    'x-slack-request-timestamp': '1700000000',
    'user-agent': 'Slackbot 1.0 (+https://api.slack.com/robots)',
  }),
};

const headersFor = (vendor: string, event?: string): Record<string, string> => ({
  'content-type': 'application/json',
  accept: '*/*',
  ...(VENDOR_HEADERS[vendor]?.(event) ?? {}),
});

/**
 * Wrap a vendor payload the way the Webhook node delivers it, so expressions
 * written against `$json.body.…` are exercised exactly as authored.
 *
 * `rawBody` is deliberately not modelled: with it enabled n8n delivers the body
 * as binary rather than parsed JSON, which no expression-pure node can read, so
 * such a workflow reaches a boundary before the body matters.
 */
export function wrapWebhook(payload: unknown, options: EnvelopeOptions): WebhookItem {
  return {
    headers: headersFor(options.vendor, options.event),
    params: {},
    query: {},
    body: payload,
  };
}

type Schema = Record<string, unknown>;

const isSchema = (v: unknown): v is Schema => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A permissive object schema for the envelope parts nothing constrains. */
const anyObject = { type: 'object', additionalProperties: true };

function envelopeFor(branch: Schema, vendor: string): Schema {
  const event = branch[EVENT_KEY];
  const headerValue = branch[EVENT_HEADER_KEY];

  // The annotations belong to the envelope, not to the payload shape.
  const body = { ...branch };
  delete body[EVENT_KEY];
  delete body[EVENT_HEADER_KEY];

  const headerName = Object.keys(VENDOR_HEADERS[vendor]?.() ?? {}).find((name) =>
    name.endsWith('-event'),
  );

  const headers: Schema = { type: 'object', additionalProperties: true };
  if (headerName !== undefined && typeof headerValue === 'string') {
    headers.properties = { [headerName]: { type: 'string', const: headerValue } };
    headers.required = [headerName];
  }

  return {
    type: 'object',
    required: ['headers', 'params', 'query', 'body'],
    properties: { headers, params: anyObject, query: anyObject, body },
    ...(typeof event === 'string' ? { [EVENT_KEY]: event } : {}),
  };
}

/**
 * Lift a payload schema to the envelope level, so the generator's focus paths
 * (`body.data.object.id`) line up with the expressions a workflow actually
 * writes. Each `oneOf` branch becomes its own envelope, which is what lets a
 * header-discriminated vendor like GitHub carry its `const` where it belongs.
 */
export function wrapWebhookSchema(schema: unknown, options: { vendor: string }): unknown {
  if (!isSchema(schema)) return schema;
  const branches = schema.oneOf;
  if (Array.isArray(branches)) {
    return { oneOf: branches.filter(isSchema).map((branch) => envelopeFor(branch, options.vendor)) };
  }
  return envelopeFor(schema, options.vendor);
}
