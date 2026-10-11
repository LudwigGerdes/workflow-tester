import { describe, expect, it } from 'vitest';
import { planHttpRequest } from '../src/http-plan.js';

const base = { method: 'POST', url: 'https://api.acme.com/v1/orders', authentication: 'none', options: {} };

type Planned = { requests: Array<{ url: string; body?: unknown; headers: Record<string, string> }> };

describe('planHttpRequest', () => {
  it('plans one request per item: method, url, json keypair body nested, headers lowercased', () => {
    const plan = planHttpRequest(4.2, [
      {
        ...base,
        sendBody: true,
        contentType: 'json',
        specifyBody: 'keypair',
        bodyParameters: { parameters: [{ name: 'customer.email', value: 'a@x.io' }] },
        sendHeaders: true,
        specifyHeaders: 'keypair',
        headerParameters: { parameters: [{ name: 'X-Trace', value: '1' }, { name: '', value: 'dropped' }] },
      },
    ]);
    expect(plan).toEqual({
      requests: [
        {
          itemIndex: 0,
          method: 'POST',
          url: 'https://api.acme.com/v1/orders',
          headers: { 'x-trace': '1', 'content-type': 'application/json' },
          body: { customer: { email: 'a@x.io' } },
        },
      ],
      fullResponse: false,
      neverError: false,
      responseFormat: 'autodetect',
    });
  });

  it('query keypair: repeated names are last-wins before 4.3 and arrays from 4.3', () => {
    const p = {
      ...base,
      method: 'GET',
      sendQuery: true,
      specifyQuery: 'keypair',
      queryParameters: { parameters: [{ name: 'tag', value: 'a' }, { name: 'tag', value: 'b' }] },
    };
    expect((planHttpRequest(4.2, [p]) as Planned).requests[0]!.url).toBe('https://api.acme.com/v1/orders?tag=b');
    // From 4.3 a repeated name is an array. With no "Array Format" option
    // n8n leaves axios 1.18's default serializer, which writes brackets
    // (measured: tag%5B%5D=a&tag%5B%5D=b); only `repeat` writes the name bare.
    expect((planHttpRequest(4.3, [p]) as Planned).requests[0]!.url).toBe('https://api.acme.com/v1/orders?tag%5B%5D=a&tag%5B%5D=b');
    const repeat = { ...p, options: { queryParameterArrays: 'repeat' } };
    expect((planHttpRequest(4.3, [repeat]) as Planned).requests[0]!.url).toBe('https://api.acme.com/v1/orders?tag=a&tag=b');
    const brackets = { ...p, options: { queryParameterArrays: 'brackets' } };
    expect((planHttpRequest(4.3, [brackets]) as Planned).requests[0]!.url).toBe('https://api.acme.com/v1/orders?tag%5B%5D=a&tag%5B%5D=b');
  });

  it('json body string is parsed; form string and raw keep their content types', () => {
    const json = planHttpRequest(4.5, [{ ...base, sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '{"a":1}' }]) as Planned;
    expect(json.requests[0]!.body).toEqual({ a: 1 });
    const form = planHttpRequest(4.5, [{ ...base, sendBody: true, contentType: 'form-urlencoded', specifyBody: 'string', body: 'a=1&b=2' }]) as Planned;
    expect(form.requests[0]!.body).toBe('a=1&b=2');
    expect(form.requests[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const raw = planHttpRequest(4.5, [{ ...base, sendBody: true, contentType: 'raw', rawContentType: 'text/csv', body: 'x,y' }]) as Planned;
    expect(raw.requests[0]).toMatchObject({ body: 'x,y', headers: { 'content-type': 'text/csv' } });
  });

  it.each([
    [3, {}, 'HTTP Request v3: only versions 4 to 4.5 are answered offline'],
    [4.2, { authentication: 'predefinedCredentialType' }, 'credentials are not sent offline'],
    [4.2, { options: { pagination: { pagination: { paginationMode: 'responseContainsNextURL' } } } }, 'pagination is not answered offline'],
    [4.2, { options: { batching: { batch: {} } } }, 'batching is not answered offline'],
    [4.2, { sendBody: true, contentType: 'multipart-form-data' }, 'binary and multipart bodies are not answered offline'],
    [4.2, { sendBody: true, contentType: 'binaryData' }, 'binary and multipart bodies are not answered offline'],
    [4.2, { options: { response: { response: { responseFormat: 'file' } } } }, 'file responses are not answered offline'],
    [4.2, { url: '/relative' }, 'the URL does not evaluate to an absolute http(s) URL'],
  ])('v%s %j is unsupported: %s', (version, over, reason) => {
    expect(planHttpRequest(version, [{ ...base, ...over }])).toEqual({ unsupported: reason });
  });

  it('pagination set to off is fine', () => {
    expect('requests' in planHttpRequest(4.2, [{ ...base, options: { pagination: { pagination: { paginationMode: 'off' } } } }])).toBe(true);
  });
});
