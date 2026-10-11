import { describe, expect, it } from 'vitest';
import type { Boundary, EngineInput, EngineResult, WorkflowJson } from 'workflow-tester-engine';
import { walkWithMock, type ServeClient } from '../src/offline-mock.js';

const empty: EngineResult = {
  status: 'pass', reachedNodes: [], outputs: {}, failures: [], warnings: [], boundaries: [], substituted: [], errorOutputs: [], durationMs: 0,
};
const httpBoundary = (node: string, url: string): Boundary => ({
  node,
  type: 'n8n-nodes-base.httpRequest',
  reason: 'not-pure',
  inputItems: [{ json: {} }],
  request: { requests: [{ itemIndex: 0, method: 'GET', url, headers: {} }], fullResponse: false, neverError: false, responseFormat: 'autodetect' },
});
const http = (name: string) => ({ name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, parameters: {}, position: [0, 0] as [number, number], id: name });
const workflow: WorkflowJson = { nodes: [http('A'), http('B')], connections: {} };
const never: ServeClient = { serve: async () => { throw new Error('must not be called'); } };

describe('walkWithMock', () => {
  it('answers one HTTP node per round, in walk order, until no new plan', async () => {
    const seen: EngineInput[] = [];
    const walkOnce = async (input: EngineInput): Promise<EngineResult> => {
      seen.push(input);
      if (input.routed?.['A'] === undefined) return { ...empty, status: 'boundary', boundaries: [httpBoundary('A', 'https://x.io/a')] };
      if (input.routed?.['B'] === undefined) return { ...empty, status: 'boundary', boundaries: [httpBoundary('B', 'https://x.io/b')] };
      return empty;
    };
    const calls: string[] = [];
    const mock: ServeClient = {
      serve: async (r) => {
        calls.push(r.url);
        return { status: 200, headers: { 'content-type': 'application/json' }, body: { ok: true } };
      },
    };
    const out = await walkWithMock({ workflow, trigger: 'T', payload: {} }, walkOnce, mock);
    expect(calls).toEqual(['https://x.io/a', 'https://x.io/b']);
    expect(out.answered).toEqual(['A', 'B']);
    expect(seen).toHaveLength(3);
    expect(seen.every((i) => i.planRequests === true)).toBe(true);
  });

  it('an unsupported plan stays a boundary and the loop ends', async () => {
    const walkOnce = async (): Promise<EngineResult> => ({
      ...empty, status: 'boundary', boundaries: [{ ...httpBoundary('A', ''), request: { unsupported: 'pagination is not answered offline' } }],
    });
    const out = await walkWithMock({ workflow, trigger: 'T', payload: {} }, walkOnce, never);
    expect(out.answered).toEqual([]);
    expect(out.result.boundaries).toHaveLength(1);
  });

  it('a node with no input items plans nothing and the loop ends', async () => {
    let rounds = 0;
    const walkOnce = async (input: EngineInput): Promise<EngineResult> => {
      rounds += 1;
      return input.routed?.['A'] !== undefined
        ? empty
        : { ...empty, status: 'boundary', boundaries: [{ ...httpBoundary('A', ''), inputItems: [], request: { requests: [], fullResponse: false, neverError: false, responseFormat: 'autodetect' } }] };
    };
    const out = await walkWithMock({ workflow, trigger: 'T', payload: {} }, walkOnce, never);
    expect(out.answered).toEqual(['A']);
    expect(rounds).toBe(2);
  });

  it('a raised error is passed as raised, not routed', async () => {
    let last: EngineInput | undefined;
    const walkOnce = async (input: EngineInput): Promise<EngineResult> => {
      last = input;
      return input.raised?.['A'] === undefined ? { ...empty, status: 'boundary', boundaries: [httpBoundary('A', 'https://x.io/a')] } : empty;
    };
    await walkWithMock({ workflow, trigger: 'T', payload: {} }, walkOnce, { serve: async () => ({ status: 503, headers: {}, body: {} }) });
    expect(last?.raised).toEqual({ A: 'the mock answered 503' });
  });
});

describe('walkWithMock: legacy continueOnFail', () => {
  it('a node with continueOnFail and no onError continues on its regular output', async () => {
    const legacy: WorkflowJson = { nodes: [{ ...http('A'), continueOnFail: true }], connections: {} };
    let last: EngineInput | undefined;
    const walkOnce = async (input: EngineInput): Promise<EngineResult> => {
      last = input;
      return input.routed?.['A'] === undefined && input.raised?.['A'] === undefined
        ? { ...empty, status: 'boundary', boundaries: [httpBoundary('A', 'https://x.io/a')] }
        : empty;
    };
    await walkWithMock({ workflow: legacy, trigger: 'T', payload: {} }, walkOnce, { serve: async () => ({ status: 503, headers: {}, body: {} }) });
    expect(last?.raised).toEqual({});
    expect(last?.routed?.['A']).toEqual([[{ json: { error: 'the mock answered 503' }, pairedItem: { item: 0 } }]]);
  });
});
