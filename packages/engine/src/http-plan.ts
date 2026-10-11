/**
 * The requests an HTTP Request node would send, worked out offline from its
 * resolved parameters, so a local integration-mock can answer them. Mirrors
 * n8n 2.38.3's `HttpRequestV3.node.ts`; anything it does not reproduce is
 * reported as unsupported, which leaves the node a boundary.
 */
export const HTTP_REQUEST_TYPE = 'n8n-nodes-base.httpRequest';

export interface PlannedRequest {
  itemIndex: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export type HttpPlan =
  | {
      requests: PlannedRequest[];
      fullResponse: boolean;
      neverError: boolean;
      responseFormat: 'autodetect' | 'json' | 'text';
    }
  | { unsupported: string };

interface Pair {
  name?: unknown;
  value?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const isPair = (v: unknown): v is Pair => isRecord(v);

const pairs = (collection: unknown): Pair[] =>
  isRecord(collection) && Array.isArray(collection['parameters'])
    ? collection['parameters'].filter(isPair)
    : [];

/** Repeated names: last wins before 4.3, an array from 4.3 (GenericFunctions.ts:320). */
function fold(list: Pair[], version: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { name, value } of list) {
    const key = String(name ?? '');
    const prior = out[key];
    if (version < 4.3 || prior === undefined) out[key] = value;
    else out[key] = Array.isArray(prior) ? [...prior, value] : [prior, value];
  }
  return out;
}

/** lodash `set` for `a.b[0].c` paths, as the JSON keypair body uses (GenericFunctions.ts:282). */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter((k) => k !== '');
  let cursor: Record<string, unknown> = target;
  keys.forEach((key, i) => {
    if (i === keys.length - 1) {
      cursor[key] = value;
      return;
    }
    const existing = cursor[key];
    if (existing === null || typeof existing !== 'object') {
      cursor[key] = /^\d+$/.test(keys[i + 1] ?? '') ? [] : {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  });
}

const parse = (v: unknown): unknown => (typeof v === 'string' ? (JSON.parse(v) as unknown) : v);

const stringValues = (h: Record<string, unknown>, lowercase: boolean): Record<string, string> =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [lowercase ? k.toLowerCase() : k, String(v)]));

const appendAll = (params: URLSearchParams, fields: Record<string, unknown>): void => {
  for (const [k, v] of Object.entries(fields)) {
    for (const one of Array.isArray(v) ? v : [v]) params.append(k, String(one));
  }
};

const NOT_ABSOLUTE = 'the URL does not evaluate to an absolute http(s) URL';

function planOne(version: number, p: Record<string, unknown>, itemIndex: number): PlannedRequest | string {
  if ((p['authentication'] ?? 'none') !== 'none') return 'credentials are not sent offline';
  const options = isRecord(p['options']) ? p['options'] : {};
  const pagination = isRecord(options['pagination']) ? options['pagination']['pagination'] : undefined;
  if (isRecord(pagination) && (pagination['paginationMode'] ?? 'updateAParameterInEachRequest') !== 'off') {
    return 'pagination is not answered offline';
  }
  if (options['batching'] !== undefined) return 'batching is not answered offline';

  let url: URL;
  try {
    url = new URL(String(p['url'] ?? ''));
  } catch {
    return NOT_ABSOLUTE;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return NOT_ABSOLUTE;

  try {
    if (p['sendQuery'] === true) {
      const qs = p['specifyQuery'] === 'json' ? parse(p['jsonQuery']) : fold(pairs(p['queryParameters']), version);
      appendAll(url.searchParams, isRecord(qs) ? qs : {});
    }

    let headers: Record<string, string> = {};
    if (p['sendHeaders'] === true) {
      const raw =
        p['specifyHeaders'] === 'json'
          ? parse(p['jsonHeaders'])
          : fold(pairs(p['headerParameters']).filter((h) => String(h.name ?? '') !== ''), version);
      headers = stringValues(isRecord(raw) ? raw : {}, options['lowercaseHeaders'] !== false);
    }

    let body: unknown;
    if (p['sendBody'] === true) {
      const contentType = String(p['contentType'] ?? 'json');
      const specify = String(p['specifyBody'] ?? 'keypair');
      if (contentType === 'multipart-form-data' || contentType === 'binaryData') {
        return 'binary and multipart bodies are not answered offline';
      }
      if (contentType === 'json') {
        if (specify === 'json') {
          body = parse(p['jsonBody']);
        } else {
          const out: Record<string, unknown> = {};
          for (const { name, value } of pairs(p['bodyParameters'])) setPath(out, String(name ?? ''), value);
          body = out;
        }
        headers['content-type'] ??= 'application/json';
      } else if (contentType === 'form-urlencoded') {
        const fields =
          specify === 'string'
            ? Object.fromEntries(new URLSearchParams(String(p['body'] ?? '')))
            : fold(pairs(p['bodyParameters']), version);
        const encoded = new URLSearchParams();
        appendAll(encoded, fields);
        body = encoded.toString();
        headers['content-type'] ??= 'application/x-www-form-urlencoded';
      } else if (contentType === 'raw') {
        body = String(p['body'] ?? '');
        headers['content-type'] = String(p['rawContentType'] ?? '');
      }
    }

    return {
      itemIndex,
      method: String(p['method'] ?? 'GET').toUpperCase(),
      url: url.toString(),
      headers,
      ...(body === undefined ? {} : { body }),
    };
  } catch {
    return 'a JSON parameter is not valid JSON';
  }
}

export function planHttpRequest(typeVersion: number, resolved: Array<Record<string, unknown>>): HttpPlan {
  if (typeVersion < 4) {
    return { unsupported: `HTTP Request v${typeVersion}: only versions 4 to 4.5 are answered offline` };
  }
  const first = resolved[0] ?? {};
  const options = isRecord(first['options']) ? first['options'] : {};
  const outer = isRecord(options['response']) ? options['response']['response'] : undefined;
  const response = isRecord(outer) ? outer : {};
  const format = String(response['responseFormat'] ?? 'autodetect');
  if (format === 'file') return { unsupported: 'file responses are not answered offline' };
  const requests: PlannedRequest[] = [];
  for (const [i, p] of resolved.entries()) {
    const one = planOne(typeVersion, p, i);
    if (typeof one === 'string') return { unsupported: one };
    requests.push(one);
  }
  return {
    requests,
    fullResponse: response['fullResponse'] === true,
    neverError: response['neverError'] === true,
    responseFormat: format === 'json' || format === 'text' ? format : 'autodetect',
  };
}
