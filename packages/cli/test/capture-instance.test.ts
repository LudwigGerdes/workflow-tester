import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { InstanceClient } from 'workflow-test-instance';
import { captureCommand } from '../src/commands/capture.js';
import type { Io } from '../src/io.js';

let dir: string;
let out: string[];
let err: string[];
const io = (): Io => ({
  cwd: dir,
  out: (s) => out.push(s),
  err: (s) => err.push(s),
  env: { N8N_API_URL: 'https://n8n.example', N8N_API_KEY: 'k' },
});

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

const execution = (who: unknown) => ({
  id: '7',
  workflowData: { nodes: [{ name: 'Webhook', id: 'n1' }] },
  data: {
    resultData: { runData: { Webhook: [{ data: { main: [[{ json: { who } }]] } }] } },
  },
});

const clientWith = (
  list: Array<{ id: string; startedAt: string }>,
  byId: Record<string, unknown>,
): InstanceClient => ({
  getWorkflow: async () => WORKFLOW,
  listExecutions: async () =>
    list.map((e) => ({
      id: e.id,
      status: 'success',
      startedAt: e.startedAt,
      finished: true,
      mode: 'webhook',
      workflowId: 'W1',
    })),
  getExecution: async (id: string) => byId[id],
});

const sidecar = () =>
  parseYaml(readFileSync(join(dir, 'workflows/invoice.contract.yaml'), 'utf8')) as {
    capture?: { executionId?: string; nodes?: Record<string, unknown> };
  } | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-test-inst-'));
  out = [];
  err = [];
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  writeFileSync(join(dir, 'workflows/invoice.json'), JSON.stringify(WORKFLOW, null, 2));
});

describe('capture --instance', () => {
  it('records the newest execution the instance has', async () => {
    const client = clientWith(
      [
        { id: '7', startedAt: '2026-09-07T20:00:00.000Z' },
        { id: '6', startedAt: '2026-09-07T19:00:00.000Z' },
      ],
      { '7': execution('ada') },
    );
    const code = await captureCommand(
      ['workflows/invoice.json', '--instance', 'https://n8n.example'],
      io(),
      { client },
    );
    expect(code).toBe(0);
    expect(sidecar()?.capture?.executionId).toBe('7');
    expect(Object.keys(sidecar()?.capture?.nodes ?? {})).toContain('Webhook');
  });

  it('says so plainly when the workflow has never run', async () => {
    const client = clientWith([], {});
    const code = await captureCommand(
      ['workflows/invoice.json', '--instance', 'https://n8n.example'],
      io(),
      { client },
    );
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/no execution|never run|awaiting/i);
  });

  it('fails with a configuration code when there is no key', async () => {
    const bare: Io = { cwd: dir, out: (s) => out.push(s), err: (s) => err.push(s), env: {} };
    const code = await captureCommand(
      ['workflows/invoice.json', '--instance', 'https://n8n.example'],
      bare,
    );
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/N8N_API_KEY/);
  });

  it('still refuses both sources at once rather than guessing', async () => {
    const code = await captureCommand(
      ['workflows/invoice.json', '--instance', 'https://n8n.example', '--execution', 'x.json'],
      io(),
      { client: clientWith([], {}) },
    );
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/--instance|--execution/);
  });
});
