import type { IDataObject, INodeExecutionData } from 'n8n-workflow';
import type { HttpPlan } from 'workflow-tester-engine';

/** What the mock's `POST /serve` answered. */
export interface ServeReply {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type ReplyOutcome = { routed: INodeExecutionData[][] } | { raised: string };

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content' };

/**
 * A reply value as item json. n8n puts whatever the response held there,
 * array elements included, so this does not narrow it.
 */
const asJson = (value: unknown): IDataObject => value as IDataObject;

/**
 * Turn the mock's replies into the items n8n 2.38.3's HTTP Request node would
 * emit (HttpRequestV3.node.ts, 855-1175). An error item carries only `error`:
 * n8n's `details` object (4.5 and later) is not reproduced.
 */
export function itemsFromReplies(
  plan: Extract<HttpPlan, { requests: unknown }>,
  replies: ServeReply[],
  node: { onError?: string },
  errorOutputIndex: number,
): ReplyOutcome {
  const regular: INodeExecutionData[] = [];
  const failed: INodeExecutionData[] = [];
  for (const [i, reply] of replies.entries()) {
    const pairedItem = { item: plan.requests[i]?.itemIndex ?? i };
    const ok = (reply.status >= 200 && reply.status < 300) || plan.neverError;
    if (!ok) {
      const message = `the mock answered ${reply.status}`;
      if (node.onError === 'continueRegularOutput') regular.push({ json: { error: message }, pairedItem });
      else if (node.onError === 'continueErrorOutput') failed.push({ json: { error: message }, pairedItem });
      else return { raised: message };
      continue;
    }
    const contentType = reply.headers['content-type'] ?? '';
    const isJson =
      plan.responseFormat === 'json' ||
      (plan.responseFormat === 'autodetect' && contentType.includes('application/json'));
    const body = isJson && (reply.body === undefined || reply.body === '') ? {} : reply.body;
    if (plan.fullResponse) {
      regular.push({
        json: asJson({
          ...(isJson ? { body } : { data: body }),
          headers: reply.headers,
          statusCode: reply.status,
          statusMessage: STATUS_TEXT[reply.status] ?? '',
        }),
        pairedItem,
      });
    } else if (!isJson) {
      regular.push({ json: asJson({ data: body }), pairedItem });
    } else if (Array.isArray(body)) {
      for (const element of body) regular.push({ json: asJson(element), pairedItem });
    } else {
      regular.push({ json: asJson(body), pairedItem });
    }
  }
  if (node.onError === 'continueErrorOutput') {
    const routed: INodeExecutionData[][] = Array.from({ length: errorOutputIndex + 1 }, () => []);
    routed[0] = regular;
    routed[errorOutputIndex] = failed;
    return { routed };
  }
  return { routed: [regular] };
}
