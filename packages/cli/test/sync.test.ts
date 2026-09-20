import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { InstanceClient } from 'payload-contract-instance';
import { parseInterval, syncCommand, syncOnce } from '../src/commands/sync.js';
import type { Io } from '../src/io.js';

let dir: string;
let out: string[];
let err: string[];
const io = (mode?: string): Io => ({
  cwd: dir,
  out: (s) => out.push(s),
  err: (s) => err.push(s),
  env: {
    N8N_API_URL: 'https://n8n.example',
    N8N_API_KEY: 'k',
    ...(mode === undefined ? {} : { PAYLOAD_CONTRACT_MODE: mode }),
  },
});
const stdout = () => out.join('\n');

const WORKFLOW = {
  id: 'W1',
  name: 'invoice',
  nodes: [
    {
      parameters: { httpMethod: 'POST', path: 'w', options: {} },
      id: 'n1',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 0],
    },
  ],
  connections: {},
};

const execution = (id: string, who: unknown) => ({
  id,
  workflowData: { nodes: [{ name: 'Webhook', id: 'n1' }] },
  data: { resultData: { runData: { Webhook: [{ data: { main: [[{ json: { who } }]] } }] } } },
});

const client = (newestId: string, who: unknown): InstanceClient => ({
  getWorkflow: async () => WORKFLOW,
  listExecutions: async () => [
    {
      id: newestId,
      status: 'success',
      startedAt: '2026-09-07T20:00:00.000Z',
      finished: true,
      mode: 'webhook',
      workflowId: 'W1',
    },
  ],
  getExecution: async (id: string) => execution(id, who),
});

/** Write a sidecar that already records execution `id`. */
const withCapture = (id: string, type: string) =>
  writeFileSync(
    join(dir, 'workflows/invoice.contract.yaml'),
    [
      'version: 1',
      'capture:',
      "  capturedAt: '2026-09-07T00:00:00.000Z'",
      `  executionId: '${id}'`,
      '  nodes:',
      '    Webhook:',
      '      id: n1',
      '      shape:',
      '        type: object',
      '        fields:',
      '          who:',
      `            type: ${type}`,
      '      items: 1',
      '',
    ].join('\n'),
  );

const recorded = () =>
  parseYaml(readFileSync(join(dir, 'workflows/invoice.contract.yaml'), 'utf8')) as {
    capture?: { executionId?: string };
  } | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'payload-contract-sync-'));
  out = [];
  err = [];
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  writeFileSync(join(dir, 'workflows/invoice.json'), JSON.stringify(WORKFLOW, null, 2));
});

describe('syncOnce', () => {
  it('does nothing when the recorded execution is already the newest', async () => {
    withCapture('7', 'string');
    const result = await syncOnce(io('dev'), client('7', 'ada'));
    expect(result.checked).toBe(1);
    expect(result.captured).toEqual([]);
    expect(recorded()?.capture?.executionId).toBe('7');
  });

  it('captures a newer execution in dev', async () => {
    withCapture('6', 'string');
    const result = await syncOnce(io('dev'), client('7', 'ada'));
    expect(result.captured).toEqual(['workflows/invoice.json']);
    expect(recorded()?.capture?.executionId).toBe('7');
  });

  it('reports a newer execution in test without writing', async () => {
    withCapture('6', 'string');
    const result = await syncOnce(io('test'), client('7', 'ada'));
    expect(result.captured).toEqual([]);
    expect(result.behind).toEqual(['workflows/invoice.json']);
    expect(recorded()?.capture?.executionId).toBe('6');
    expect(stdout()).toMatch(/behind|newer/i);
  });

  it('skips a workflow whose sidecar records no capture', async () => {
    writeFileSync(join(dir, 'workflows/invoice.contract.yaml'), 'version: 1\n');
    const result = await syncOnce(io('dev'), client('7', 'ada'));
    expect(result.checked).toBe(0);
    expect(result.captured).toEqual([]);
  });

  it('carries on past a workflow the instance does not know', async () => {
    withCapture('6', 'string');
    const angry: InstanceClient = {
      getWorkflow: async () => {
        throw new Error('404');
      },
      listExecutions: async () => {
        throw new Error('workflow not found');
      },
      getExecution: async () => ({}),
    };
    const result = await syncOnce(io('dev'), angry);
    expect(result.checked).toBe(1);
    expect(result.captured).toEqual([]);
    expect(err.join('\n')).toMatch(/not found/);
  });
});

describe('parseInterval', () => {
  it('reads seconds', () => {
    expect(parseInterval('30s')).toBe(30_000);
  });

  it('reads minutes', () => {
    expect(parseInterval('2m')).toBe(120_000);
  });

  it('refuses a bare number, so the unit is never guessed', () => {
    expect(parseInterval('30')).toBeUndefined();
  });

  it('refuses nonsense', () => {
    expect(parseInterval('soon')).toBeUndefined();
  });

  it('refuses zero and negatives', () => {
    expect(parseInterval('0s')).toBeUndefined();
    expect(parseInterval('-5s')).toBeUndefined();
  });
});

describe('syncCommand', () => {
  it('runs a single pass with --once and reports what it did', async () => {
    withCapture('6', 'string');
    const code = await syncCommand(['--once'], io('dev'), { client: client('7', 'ada') });
    expect(code).toBe(0);
    expect(stdout()).toMatch(/captured execution 7/);
  });

  it('exits 1 with --once in test mode when a capture is behind', async () => {
    withCapture('6', 'string');
    const code = await syncCommand(['--once'], io('test'), { client: client('7', 'ada') });
    expect(code).toBe(1);
  });

  it('exits 0 with --once when everything is current', async () => {
    withCapture('7', 'string');
    expect(await syncCommand(['--once'], io('test'), { client: client('7', 'ada') })).toBe(0);
  });

  it('rejects a bad interval with a configuration code', async () => {
    const code = await syncCommand(['--interval', 'soon'], io('dev'), {
      client: client('7', 'ada'),
    });
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/interval/);
  });

  it('fails with a configuration code when there is no key', async () => {
    const bare: Io = {
      cwd: dir,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      env: { N8N_API_URL: 'https://n8n.example' },
    };
    expect(await syncCommand(['--once'], bare)).toBe(2);
    expect(err.join('\n')).toMatch(/N8N_API_KEY/);
  });
});
