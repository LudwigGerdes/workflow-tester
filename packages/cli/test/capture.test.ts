import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { beforeEach, describe, expect, it } from 'vitest';
import { nodesFromExecution, readCapture } from '../src/commands/capture.js';
import { run } from '../src/index.js';

let dir: string;
let out: string[];
let err: string[];
const io = () => ({ cwd: dir, out: (s: string) => out.push(s), err: (s: string) => err.push(s) });

/** An n8n execution export, in the shape n8n actually writes. */
const execution = (items: unknown[]) => ({
  id: 4211,
  workflowData: { nodes: [{ name: 'Format Customer', id: 'n2' }] },
  data: {
    resultData: {
      runData: {
        'Format Customer': [{ data: { main: [items.map((json) => ({ json }))] } }],
      },
    },
  },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-tester-capture-'));
  out = [];
  err = [];
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  writeFileSync(join(dir, 'workflows/invoice.json'), JSON.stringify({ id: 'w', nodes: [] }));
});

describe('nodesFromExecution', () => {
  it('records each node output as shape', () => {
    const nodes = nodesFromExecution(execution([{ id: 1, email: 'ada@x.io' }]));
    expect(nodes['Format Customer']?.shape).toEqual({
      type: 'object',
      fields: { id: { type: 'number' }, email: { type: 'string' } },
    });
  });

  it('keeps no values, which is the whole point', () => {
    const nodes = nodesFromExecution(execution([{ email: 'ada@x.io' }]));
    expect(JSON.stringify(nodes)).not.toContain('ada@x.io');
  });

  it('carries the node id, so a rename is not read as a deletion', () => {
    expect(nodesFromExecution(execution([{ a: 1 }]))['Format Customer']?.id).toBe('n2');
  });

  it('merges every run of a node, so a loop does not hide a field', () => {
    const exec = {
      data: {
        resultData: {
          runData: {
            Loop: [
              { data: { main: [[{ json: { a: 1 } }]] } },
              { data: { main: [[{ json: { a: 1, b: 2 } }]] } },
            ],
          },
        },
      },
    };
    const shape = nodesFromExecution(exec)['Loop']?.shape;
    expect(shape?.fields?.['b']).toEqual({ type: 'number', optional: true });
  });

  it('skips a node that produced nothing', () => {
    const exec = { data: { resultData: { runData: { Quiet: [{ data: { main: [[]] } }] } } } };
    expect(nodesFromExecution(exec)).toEqual({});
  });
});

describe('workflow-tester capture', () => {
  it('writes a capture into the workflow sidecar', async () => {
    writeFileSync(join(dir, 'exec.json'), JSON.stringify(execution([{ id: 1 }])));
    expect(await run(['capture', 'workflows/invoice.json', '--execution', 'exec.json'], io())).toBe(0);

    const sidecar = parseYaml(
      readFileSync(join(dir, 'workflows/invoice.contract.yaml'), 'utf8'),
    ) as { capture: { executionId: string; nodes: Record<string, unknown> } };
    expect(sidecar.capture.executionId).toBe('4211');
    expect(Object.keys(sidecar.capture.nodes)).toEqual(['Format Customer']);
  });

  it('lands beside the workflow, so it travels with it on promotion', async () => {
    writeFileSync(join(dir, 'exec.json'), JSON.stringify(execution([{ id: 1 }])));
    await run(['capture', 'workflows/invoice.json', '--execution', 'exec.json'], io());
    expect(readCapture(join(dir, 'workflows/invoice.json'))?.nodes).toBeDefined();
  });

  it('preserves anything already in the sidecar', async () => {
    writeFileSync(
      join(dir, 'workflows/invoice.contract.yaml'),
      'version: 1\ntrigger: Webhook\n',
      'utf8',
    );
    writeFileSync(join(dir, 'exec.json'), JSON.stringify(execution([{ id: 1 }])));
    await run(['capture', 'workflows/invoice.json', '--execution', 'exec.json'], io());

    const sidecar = parseYaml(
      readFileSync(join(dir, 'workflows/invoice.contract.yaml'), 'utf8'),
    ) as { trigger: string; capture: unknown };
    expect(sidecar.trigger).toBe('Webhook');
    expect(sidecar.capture).toBeDefined();
  });

  it('records awaiting-first-execution rather than writing an empty capture', async () => {
    expect(await run(['capture', 'workflows/invoice.json', '--awaiting'], io())).toBe(0);
    const capture = readCapture(join(dir, 'workflows/invoice.json'));
    expect(capture?.awaitingFirstExecution).toBe(true);
    expect(capture?.nodes).toBeUndefined();
  });

  it('refuses an execution with no node output rather than recording emptiness', async () => {
    writeFileSync(join(dir, 'empty.json'), JSON.stringify({ data: { resultData: { runData: {} } } }));
    expect(await run(['capture', 'workflows/invoice.json', '--execution', 'empty.json'], io())).toBe(2);
    expect(err.join('\n')).toMatch(/records no node output/);
  });

  it('reports a missing workflow as a usage error', async () => {
    expect(await run(['capture', 'workflows/nope.json', '--awaiting'], io())).toBe(2);
    expect(err.join('\n')).toMatch(/no such workflow/);
  });

  it('needs a source', async () => {
    expect(await run(['capture', 'workflows/invoice.json'], io())).toBe(2);
    expect(err.join('\n')).toMatch(/--execution/);
  });
});

describe('capture provenance', () => {
  const provenance = () =>
    (parseYaml(readFileSync(join(dir, 'workflows/invoice.contract.yaml'), 'utf8')) as {
      capture: {
        tool?: { name: string; version: string };
        source?: { kind: string; instance?: string; executionId?: string; status?: string };
        workflow?: { id?: string; name?: string; versionId?: string };
        n8nVersion?: string;
      };
    }).capture;

  const richExecution = () => ({
    ...execution([{ id: 1 }]),
    status: 'success',
    workflowData: {
      id: 'wf-1',
      name: 'Invoice',
      versionId: 'v-9',
      nodes: [{ name: 'Format Customer', id: 'n2' }],
    },
  });

  it('records the tool, the file source and the workflow identity from an export', async () => {
    writeFileSync(join(dir, 'exec.json'), JSON.stringify(richExecution()));
    expect(await run(['capture', 'workflows/invoice.json', '--execution', 'exec.json'], io())).toBe(0);

    const capture = provenance();
    expect(capture.tool?.name).toBe('workflow-tester');
    expect(capture.tool?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(capture.source).toEqual({ kind: 'execution-file', executionId: '4211', status: 'success' });
    expect(capture.workflow).toEqual({ id: 'wf-1', name: 'Invoice', versionId: 'v-9' });
    expect(capture.n8nVersion).toBeUndefined();
  });

  it('records the instance base url and never the key', async () => {
    const client = {
      getWorkflow: async () => ({}),
      listExecutions: async () => [
        { id: '7', status: 'success', startedAt: '2026-09-25T10:00:00.000Z', finished: true, mode: 'webhook', workflowId: 'w' },
      ],
      getExecution: async () => richExecution(),
    };
    const { captureCommand } = await import('../src/commands/capture.js');
    const code = await captureCommand(
      ['workflows/invoice.json', '--instance', 'https://n8n.example.com/'],
      { ...io(), env: { N8N_API_KEY: 'n8n_api_secret_key_value' } },
      { client },
    );
    expect(code).toBe(0);

    const capture = provenance();
    expect(capture.source).toEqual({
      kind: 'instance',
      instance: 'https://n8n.example.com',
      executionId: '4211',
      status: 'success',
    });
    expect(readFileSync(join(dir, 'workflows/invoice.contract.yaml'), 'utf8')).not.toContain('secret_key');
  });

  it('takes the n8n version from the export when it says', async () => {
    writeFileSync(
      join(dir, 'exec.json'),
      JSON.stringify({ ...richExecution(), workflowData: { ...richExecution().workflowData, meta: { n8nVersion: '2.38.3' } } }),
    );
    await run(['capture', 'workflows/invoice.json', '--execution', 'exec.json'], io());
    expect(provenance().n8nVersion).toBe('2.38.3');
  });

  it('reads an old record that has none of these fields', async () => {
    writeFileSync(
      join(dir, 'workflows/invoice.contract.yaml'),
      'version: 1\ncapture:\n  capturedAt: 2026-01-01T00:00:00.000Z\n  executionId: "1"\n  nodes:\n    Format Customer:\n      items: 1\n      shape:\n        type: object\n        fields:\n          id:\n            type: number\n',
    );
    const capture = readCapture(join(dir, 'workflows/invoice.json'));
    expect(capture?.executionId).toBe('1');
    expect(capture?.tool).toBeUndefined();
    expect(capture?.source).toBeUndefined();
  });
});

describe('drift', () => {
  const capture = async (items: unknown[], extra: string[] = []) => {
    writeFileSync(join(dir, 'exec.json'), JSON.stringify(execution(items)));
    out = [];
    return await run(['capture', 'workflows/invoice.json', '--execution', 'exec.json', ...extra], io());
  };

  it('reports a field that stopped being produced, and does not fail', async () => {
    await capture([{ id: 1, email: 'a@x.io' }]);
    expect(await capture([{ id: 1 }])).toBe(0);
    expect(out.join('\n')).toMatch(/removed\s+email/);
  });

  it('leaves the recorded capture alone until --update', async () => {
    await capture([{ id: 1, email: 'a@x.io' }]);
    await capture([{ id: 1 }]);
    // still the original, because nobody accepted the change
    expect(readCapture(join(dir, 'workflows/invoice.json'))?.nodes?.['Format Customer']?.shape.fields)
      .toHaveProperty('email');
    expect(out.join('\n')).toMatch(/--update to accept/);
  });

  it('accepts the change when asked', async () => {
    await capture([{ id: 1, email: 'a@x.io' }]);
    expect(await capture([{ id: 1 }], ['--update'])).toBe(0);
    expect(readCapture(join(dir, 'workflows/invoice.json'))?.nodes?.['Format Customer']?.shape.fields)
      .not.toHaveProperty('email');
  });

  it('says so when nothing moved', async () => {
    await capture([{ id: 1 }]);
    await capture([{ id: 1 }]);
    expect(out.join('\n')).toMatch(/no shape change/);
  });

  it('reports a node that disappeared entirely', async () => {
    await capture([{ id: 1 }]);
    writeFileSync(join(dir, 'exec.json'), JSON.stringify({
      data: { resultData: { runData: { Other: [{ data: { main: [[{ json: { z: 1 } }]] } }] } } },
    }));
    out = [];
    await run(['capture', 'workflows/invoice.json', '--execution', 'exec.json'], io());
    expect(out.join('\n')).toMatch(/Format Customer/);
    expect(out.join('\n')).toMatch(/no longer produces output/);
  });

  it('follows a rename by node id rather than calling it a deletion', async () => {
    await capture([{ id: 1 }]);
    writeFileSync(join(dir, 'exec.json'), JSON.stringify({
      workflowData: { nodes: [{ name: 'Build Customer', id: 'n2' }] },
      data: { resultData: { runData: { 'Build Customer': [{ data: { main: [[{ json: { id: 1 } }]] } }] } } },
    }));
    out = [];
    await run(['capture', 'workflows/invoice.json', '--execution', 'exec.json'], io());
    expect(out.join('\n')).toMatch(/no shape change/);
  });
});
