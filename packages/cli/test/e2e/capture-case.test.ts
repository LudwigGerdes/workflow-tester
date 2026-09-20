import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../src/index.js';

/**
 * The vacuous pass, reproduced against a live instance on 2026-09-07: a
 * workflow with a committed capture and no cases reported
 * "0 passed, 0 failed, 0 warned" and exited 0 — a clean bill of health over a
 * workflow nothing had looked at.
 */

let dir: string;
let out: string[];
let err: string[];
const io = () => ({ cwd: dir, out: (s: string) => out.push(s), err: (s: string) => err.push(s) });
const stdout = () => out.join('\n');

const workflow = (kind: 'string' | 'number') => ({
  id: 'w',
  name: 'smoke',
  nodes: [
    {
      parameters: { httpMethod: 'POST', path: 'smoke', options: {} },
      id: 'n1',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 0],
    },
    {
      parameters: {
        mode: 'manual',
        includeOtherFields: false,
        assignments: {
          assignments: [
            kind === 'string'
              ? { id: 'a', name: 'customerName', value: '={{ $json.body.user.name }}', type: 'string' }
              : { id: 'a', name: 'customerName', value: '={{ 42 }}', type: 'number' },
          ],
        },
        options: {},
      },
      id: 'n2',
      name: 'Format',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [220, 0],
    },
  ],
  connections: { Webhook: { main: [[{ node: 'Format', type: 'main', index: 0 }]] } },
});

const write = (kind: 'string' | 'number') =>
  writeFileSync(join(dir, 'workflows/smoke.json'), JSON.stringify(workflow(kind), null, 2));

/** A capture: the trigger's shape, and a terminal node producing a string. */
const SIDECAR = [
  'version: 1',
  'capture:',
  "  capturedAt: '2026-09-07T00:00:00.000Z'",
  "  executionId: '1'",
  '  nodes:',
  '    Webhook:',
  '      id: n1',
  '      shape:',
  '        type: object',
  '        fields:',
  '          body:',
  '            type: object',
  '            fields:',
  '              user:',
  '                type: object',
  '                fields:',
  '                  name:',
  '                    type: string',
  '      items: 1',
  '    Format:',
  '      id: n2',
  '      shape:',
  '        type: object',
  '        fields:',
  '          customerName:',
  '            type: string',
  '      items: 1',
  '',
].join('\n');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'payload-contract-capture-'));
  out = [];
  err = [];
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  write('string');
  writeFileSync(join(dir, 'workflows/smoke.contract.yaml'), SIDECAR);
});

describe('a capture is a test', () => {
  it('does not pass vacuously when there is a capture and no cases', async () => {
    const code = await run(['run'], io());
    expect(stdout()).not.toMatch(/0 passed, 0 failed, 0 warned/);
    expect(code).toBe(0);
  });

  it('fails when a terminal node stops producing the recorded shape', async () => {
    write('number');
    out = [];
    expect(await run(['run'], io())).toBe(1);
    expect(stdout()).toMatch(/customerName/);
  });

  it('still reports nothing to run when there is no capture either', async () => {
    dir = mkdtempSync(join(tmpdir(), 'payload-contract-capture-'));
    out = [];
    mkdirSync(join(dir, 'workflows'), { recursive: true });
    write('string');
    expect(await run(['run'], io())).toBe(0);
    expect(stdout()).toMatch(/no cases|0 passed/i);
  });
});
