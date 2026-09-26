import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../src/index.js';

let dir: string;
let out: string[];
const io = () => ({ cwd: dir, out: (s: string) => out.push(s), err: (s: string) => out.push(s) });

/** Webhook → HTTP call → Set. The HTTP node cannot run offline. */
const workflow = {
  id: 'w',
  name: 'billing',
  nodes: [
    { parameters: { httpMethod: 'POST', path: 'b', options: {} }, id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0] },
    { parameters: { url: 'https://example.invalid/x', options: {} }, id: 'n2', name: 'Call API', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [220, 0] },
    {
      parameters: {
        mode: 'manual', includeOtherFields: false,
        assignments: { assignments: [{ id: 'a', name: 'total', value: '={{ $json.invoice.total }}', type: 'number' }] },
        options: {},
      },
      id: 'n3', name: 'Read Total', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [440, 0],
    },
  ],
  connections: {
    Webhook: { main: [[{ node: 'Call API', type: 'main', index: 0 }]] },
    'Call API': { main: [[{ node: 'Read Total', type: 'main', index: 0 }]] },
  },
};

/** A real execution of that workflow, as n8n exports it. */
const execution = {
  id: 900,
  workflowData: { nodes: [{ name: 'Call API', id: 'n2' }] },
  data: {
    resultData: {
      runData: {
        'Call API': [{ data: { main: [[{ json: { invoice: { total: 42, currency: 'EUR' } } }]] } }],
      },
    },
  },
};

const testFile = [
  'workflow: ../../workflows/billing.json',
  'cases:',
  '  - id: happy',
  '    when:',
  '      trigger: webhook',
  '      payload:',
  '        id: 1',
  '',
].join('\n');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-tester-sub-'));
  out = [];
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  mkdirSync(join(dir, '.workflow-tester/tests'), { recursive: true });
  writeFileSync(join(dir, 'workflows/billing.json'), JSON.stringify(workflow, null, 2));
  writeFileSync(join(dir, '.workflow-tester/tests/billing.test.yaml'), testFile);
  writeFileSync(join(dir, 'exec.json'), JSON.stringify(execution));
});

describe('capture then substitute, end to end', () => {
  it('stops at the HTTP node before anything is captured', async () => {
    await run(['run'], io());
    // Nothing past the call is verified yet: that is the state capture fixes.
    expect(out.join('\n')).toMatch(/live|boundary|needs/i);
  });

  it('carries past it once a real execution is captured', async () => {
    expect(await run(['capture', 'workflows/billing.json', '--execution', 'exec.json'], io())).toBe(0);
    out = [];

    // The Set node downstream reads $json.invoice.total, which only resolves
    // because the captured shape stood in for the HTTP call.
    expect(await run(['run'], io())).toBe(0);
    expect(out.join('\n')).not.toMatch(/invoice\.total/);
  });

  it('records shape only, so nothing from the run reaches the repo', async () => {
    await run(['capture', 'workflows/billing.json', '--execution', 'exec.json'], io());
    const sidecar = readFileSync(join(dir, 'workflows/billing.contract.yaml'), 'utf8');
    expect(sidecar).toContain('invoice');
    expect(sidecar).toContain('number');
    // `capturedAt` is a wall-clock ISO timestamp, so its minutes, seconds and
    // milliseconds contain arbitrary digits — including, a few percent of the
    // time, the very value this asserts is absent. Dropping that one line keeps
    // the assertion about what was recorded rather than about when.
    const recorded = sidecar
      .split('\n')
      .filter((line) => !line.includes('capturedAt'))
      .join('\n');
    expect(recorded).not.toContain('42');
    expect(recorded).not.toContain('EUR');
  });
});
