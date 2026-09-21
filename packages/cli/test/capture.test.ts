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
