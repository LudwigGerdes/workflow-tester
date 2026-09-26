import type { IDataObject, INodeExecutionData } from 'n8n-workflow';
import type { Semantics, Warning } from '../types.js';
import { UnsupportedModeError } from '../types.js';
import { setField } from './util.js';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Wrap a body under `responseKey` the way n8n's `set({}, key, value)` does. */
function keyed(key: unknown, value: unknown): unknown {
  if (typeof key !== 'string' || key.length === 0) return value;
  const wrapped: IDataObject = {};
  setField(wrapped, key, value);
  return wrapped;
}

/**
 * Respond to Webhook v1–1.5.
 *
 * The HTTP response is a side effect; what flows on is the input, unchanged —
 * n8n's `execute` ends in `return [items]`. From v1.3 (always) and v1.4 (when
 * `enableResponseOutput` is on) a second output carries the response that was
 * sent, built from the parameters exactly as n8n builds it. Every expression
 * in those parameters — a `responseBody` reading `$json` — is resolved by
 * n8n's own engine on the way, so a broken one is a failure at this node.
 *
 * Two modes are boundaries rather than interpreted: `jwt` signs with a
 * credential, and `binary` needs binary data the engine does not carry.
 */
export const respondToWebhookSemantics: Semantics = (ctx, input) => {
  const version = ctx.node.typeVersion;
  // n8n reads every parameter of this node at item 0.
  const params = ctx.resolve(0);
  const options = isRecord(params.options) ? params.options : {};
  const respondWith = typeof params.respondWith === 'string' ? params.respondWith : 'firstIncomingItem';

  if (respondWith === 'jwt') {
    throw new UnsupportedModeError(ctx.node.name, `${ctx.node.name} responds with a JWT, which needs a credential`);
  }
  if (respondWith === 'binary') {
    throw new UnsupportedModeError(ctx.node.name, `${ctx.node.name} responds with binary data, which the offline walk does not carry`);
  }

  const passed: INodeExecutionData[] = input.map((item, index) => ({ ...item, pairedItem: { item: index } }));
  const multipleOutputs = version === 1.3 || (version >= 1.4 && params.enableResponseOutput === true);

  // n8n swallows a broken expression here to `undefined` and sends an empty
  // response without a word. As with a Set assignment, that is worth a warning
  // whether or not the response output is on.
  const warnings: Warning[] = [];
  if ((respondWith === 'json' || respondWith === 'text') && params.responseBody === undefined) {
    warnings.push({
      kind: 'optional-undefined',
      node: ctx.node.name,
      parameter: 'responseBody',
      message: 'response body resolved to undefined, so an empty response would be sent',
      itemIndex: 0,
    });
  }
  if (!multipleOutputs) return { outputs: [passed], warnings };

  const headers: Record<string, unknown> = {};
  const entries = isRecord(options.responseHeaders) ? options.responseHeaders.entries : undefined;
  for (const header of Array.isArray(entries) ? entries : []) {
    if (!isRecord(header)) continue;
    headers[String(header.name).toLowerCase()] = header.value === undefined ? undefined : String(header.value);
  }
  let statusCode = typeof options.responseCode === 'number' && options.responseCode !== 0 ? options.responseCode : 200;

  let body: unknown;
  switch (respondWith) {
    case 'json': {
      const raw = params.responseBody;
      if (typeof raw === 'string' && raw.length > 0) {
        try {
          body = JSON.parse(raw) as unknown;
        } catch {
          throw new Error("Invalid JSON in 'Response Body' field");
        }
      } else if (typeof raw !== 'string') {
        body = raw;
      }
      break;
    }
    case 'text':
      body = params.responseBody;
      break;
    case 'allIncomingItems':
      body = keyed(
        options.responseKey,
        input.map((item) => item.json),
      );
      break;
    case 'firstIncomingItem':
      body = keyed(options.responseKey, input[0]?.json);
      break;
    case 'redirect':
      headers.location = params.redirectURL;
      statusCode = typeof options.responseCode === 'number' ? options.responseCode : 307;
      break;
    case 'noData':
      break;
    default:
      throw new Error(`The Response Data option "${respondWith}" is not supported!`);
  }

  const response = { body, headers, statusCode } as IDataObject;
  return { outputs: [passed, [{ json: { response } }]], warnings };
};
