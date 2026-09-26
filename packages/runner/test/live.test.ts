import { describe, expect, it } from 'vitest';
import { evaluateLive, mockGivenOf, needsLive, runLive, type MockCall, type MockControl, type LiveJob } from '../src/live.js';

const execution = (over: Record<string, unknown> = {}) => ({
  id: '77',
  status: 'success',
  data: {
    resultData: {
      runData: {
        Webhook: [{ data: { main: [[{ json: { body: { id: 'x' } } }]] } }],
        'Create Order': [{ data: { main: [[{ json: { id: 'o_1', total: 9 } }, { json: { id: 'o_2', total: 3 } }]] } }],
      },
    },
  },
  ...over,
});

const call = (over: Partial<MockCall>): MockCall => ({
  ts: 1,
  service: 'acme',
  method: 'POST',
  path: '/orders',
  status: 201,
  matchedRoute: 'create',
  ...over,
});

describe('needsLive', () => {
  it('is true for mock-only given keys and for calls/noUnmatched', () => {
    expect(needsLive({ id: 'a', when: {} })).toBe(false);
    expect(needsLive({ id: 'a', given: { pinData: {} }, when: {} })).toBe(false);
    expect(needsLive({ id: 'a', given: { faults: { acme: { status: 503 } } }, when: {} })).toBe(true);
    expect(needsLive({ id: 'a', when: {}, then: { calls: [] } })).toBe(true);
    expect(needsLive({ id: 'a', when: {}, then: { noUnmatched: true } })).toBe(true);
    expect(mockGivenOf({ pinData: {}, packs: ['acme'] })).toEqual({ packs: ['acme'] });
  });
});

describe('evaluateLive', () => {
  it('judges node outputs, item counts and execution status from the execution', () => {
    const out = evaluateLive(
      {
        'execution.status': 'success',
        'node.Create Order.items': 2,
        'node.Create Order.output[0].json.id': 'o_1',
        'node.Create Order.output[1].json.total': { gte: 3 },
      },
      execution(),
      [],
    );
    expect(out.map((a) => a.status)).toEqual(['pass', 'pass', 'pass', 'pass']);
  });

  it('judges calls and noUnmatched from the mock log', () => {
    const calls = [call({}), call({ path: '/orders/o_1', method: 'GET', matchedRoute: 'get' }), call({ service: 'other', path: '/x', matchedRoute: 'unmatched', status: 501 })];
    const out = evaluateLive(
      {
        calls: [
          { service: 'acme', method: 'POST', path: '/orders', count: 1 },
          { service: 'acme', path: '/orders/*', gte: 1 },
          { service: 'acme', count: 5 },
        ],
        noUnmatched: true,
      },
      execution(),
      calls,
    );
    expect(out.map((a) => a.status)).toEqual(['pass', 'pass', 'fail', 'fail']);
    expect(out[2]?.message).toMatch(/saw 2 call\(s\)/);
    expect(out[3]?.message).toMatch(/1 call\(s\) no route answered: POST other\/x/);
  });

  it('reads an error execution and its failing node', () => {
    const failed = execution({ status: 'error', data: { resultData: { runData: {}, error: { node: { name: 'Create Order' } } } } });
    const out = evaluateLive({ execution: { status: { errorNode: 'Create Order' } }, 'execution.errorNode': 'Create Order' }, failed, []);
    expect(out.map((a) => a.status)).toEqual(['pass', 'pass']);
    expect(evaluateLive({ 'execution.status': 'success' }, failed, [])[0]?.status).toBe('fail');
  });
});

describe('runLive', () => {
  const fakeMock = () => {
    const events: string[] = [];
    const mock: MockControl = {
      enablePacks: async (ids) => void events.push(`enable ${ids.join(',')}`),
      setFault: async (service, spec) => void events.push(`fault ${service} ${JSON.stringify(spec)}`),
      clearFaults: async () => void events.push('clear-faults'),
      resetStores: async () => void events.push('reset'),
      log: async () => [call({})],
    };
    return { mock, events };
  };
  const job = (entry: LiveJob['entry']): LiveJob => ({ entry, shownAs: 'workflows/orders.json', workflow: {}, trigger: 'Webhook', payload: { id: 'x' } });

  it('applies given to the mock, runs on the instance, and reads the log since the run began', async () => {
    const { mock, events } = fakeMock();
    const runs: unknown[] = [];
    const outcomes = await runLive(
      [job({ id: 'c1', given: { packs: ['acme'], faults: { acme: { status: 503, once: true } } }, when: {}, then: { calls: [{ service: 'acme', count: 1 }], 'execution.status': 'success' } })],
      { mock, instance: { run: async (input) => (runs.push(input), { execution: execution(), id: '77' }) } },
    );
    expect(events).toEqual(['clear-faults', 'reset', 'enable acme', 'fault acme {"status":503,"once":true}']);
    expect(runs).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'pass', mode: 'live', executionId: '77', caseId: 'c1' });
    expect(outcomes[0]?.message).toMatch(/1 call\(s\) served/);
  });

  it('a failing expectation, an instance error, and an unsupported given each fail the case with a reason', async () => {
    const { mock } = fakeMock();
    const outcomes = await runLive(
      [
        job({ id: 'bad', when: {}, then: { noUnmatched: true, 'node.Create Order.items': 9 } }),
        job({ id: 'boom', when: {} }),
        job({ id: 'snap', given: { snapshot: 'latest' }, when: {} }),
      ],
      {
        mock: { ...mock, log: async () => [call({ matchedRoute: 'unmatched' })] },
        instance: {
          run: async () => {
            if (outcomesSoFar++ === 1) throw new Error('n8n POST /api/v1/workflows → 401');
            return { execution: execution() };
          },
        },
      },
    );
    expect(outcomes.map((o) => o.status)).toEqual(['fail', 'fail', 'fail']);
    expect(outcomes[0]?.message).toMatch(/no route answered/);
    expect(outcomes[1]?.message).toMatch(/401/);
    expect(outcomes[2]?.message).toMatch(/given\.snapshot is not supported/);
  });
});
let outcomesSoFar = 0;
