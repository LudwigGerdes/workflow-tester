import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/index.js';

let dir: string;
let out: string[];
let err: string[];
// `gen` writes in every mode; `--check` is the read-only form. The env here
// only documents that these tests exercise generation.
const io = () => ({
  cwd: dir,
  out: (s: string) => out.push(s),
  err: (s: string) => err.push(s),
  env: { WORKFLOW_TESTER_MODE: 'dev' },
});
const stdout = () => out.join('\n');

/** A workflow whose Set reads one path off the trigger. */
const workflow = (expression: string) => ({
  id: 'w',
  name: 'w',
  nodes: [
    { parameters: { httpMethod: 'POST', path: 'w', options: {} }, id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0] },
    {
      parameters: {
        mode: 'manual', includeOtherFields: false,
        assignments: { assignments: [{ id: 'a', name: 'name', value: expression, type: 'string' }] },
        options: {},
      },
      id: 'n2', name: 'Extract', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [220, 0],
    },
  ],
  connections: { Webhook: { main: [[{ node: 'Extract', type: 'main', index: 0 }]] } },
});

const SCHEMA = {
  type: 'object',
  properties: {
    record: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    email: { type: 'string' },
    status: { type: 'string', enum: ['active', 'paused'] },
  },
  required: ['record'],
};

const EXAMPLES = [{ event: 'invoice.paid', payload: { record: { name: 'Ada' }, email: 'a@x.io', status: 'active' } }];

const setup = (expression = '={{ $json.body.record.name }}'): void => {
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  mkdirSync(join(dir, '.workflow-tester/contracts'), { recursive: true });
  writeFileSync(join(dir, 'workflows/invoice.json'), JSON.stringify(workflow(expression), null, 2));
  writeFileSync(
    join(dir, 'workflows/invoice.contract.yaml'),
    [
      'version: 1', 'trigger: Webhook', 'source:', '  kind: vendor', '  vendor: stripe',
      '  events:', '    - invoice.paid',
      'shape:', '  schema: ../.workflow-tester/contracts/test.record.schema.json',
      '  examples: ../.workflow-tester/contracts/test.record.examples.json', '',
    ].join('\n'),
  );
  writeFileSync(join(dir, '.workflow-tester/contracts/test.record.schema.json'), JSON.stringify(SCHEMA, null, 2));
  writeFileSync(join(dir, '.workflow-tester/contracts/test.record.examples.json'), JSON.stringify(EXAMPLES, null, 2));
};

const caseDir = () => join(dir, '.workflow-tester/cases/invoice/test.record');
const caseFiles = (): string[] => readdirSync(caseDir()).filter((f) => f !== 'index.json').sort();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-tester-gen-'));
  out = [];
  err = [];
});

describe('gen', () => {
  it('writes one file per case plus an index', async () => {
    setup();
    expect(await run(['gen'], io())).toBe(0);
    expect(caseFiles().length).toBeGreaterThan(1);

    const index = JSON.parse(readFileSync(join(caseDir(), 'index.json'), 'utf8')) as {
      cases: Array<{ id: string; title: string }>;
      stats: { examples: number };
      inputs: { workflow: string; contract: string; shape: string; generator: string };
    };
    expect(index.cases.length).toBe(caseFiles().length);
    expect(index.stats.examples).toBe(1);
    expect(index.inputs.workflow).toMatch(/^[0-9a-f]{16}$/);
    expect(index.inputs.shape).toMatch(/^[0-9a-f]{16}$/);
  });

  it('wraps cases in the webhook envelope so body.* expressions line up', async () => {
    setup();
    await run(['gen'], io());
    const first = JSON.parse(readFileSync(join(caseDir(), caseFiles()[0] as string), 'utf8')) as {
      payload: { headers: Record<string, string>; body: unknown };
    };
    expect(Object.keys(first.payload).sort()).toEqual(['body', 'headers', 'params', 'query']);
    expect(first.payload.headers['stripe-signature']).toBeDefined();
  });

  it('only varies what the workflow reads', async () => {
    setup();
    await run(['gen'], io());
    const index = JSON.parse(readFileSync(join(caseDir(), 'index.json'), 'utf8')) as {
      focus: string[];
    };
    expect(index.focus).toEqual(['body.record.name']);
  });

  it('is a no-op the second time', async () => {
    setup();
    await run(['gen'], io());
    const before = caseFiles().map((f) => readFileSync(join(caseDir(), f), 'utf8'));

    out = [];
    expect(await run(['gen'], io())).toBe(0);
    expect(caseFiles().map((f) => readFileSync(join(caseDir(), f), 'utf8'))).toEqual(before);
    expect(stdout()).toMatch(/unchanged/i);
  });

  /** How the committed cases vary a given payload path, as `kind` names. */
  const kindsOn = (path: string): string[] =>
    [...new Set(mutatedPaths().filter((m) => m.endsWith(` ${path}`)).map((m) => m.split(' ')[0]))].sort();

  /** Every `kind path` pair the committed cases vary. */
  const mutatedPaths = (): string[] =>
    caseFiles().flatMap((f) => {
      const parsed = JSON.parse(readFileSync(join(caseDir(), f), 'utf8')) as {
        provenance?: { mutations?: { path: string }[] };
      };
      return (parsed.provenance?.mutations ?? []).map((m) => `${m.kind} ${m.path}`);
    });

  it('adds cases when the workflow starts reading another path', async () => {
    setup();
    await run(['gen'], io());
    // A path nothing reads gets one blanket "what if it were absent" and no
    // more; the interesting mutations are reserved for paths the workflow reads.
    expect(kindsOn('body.status')).toEqual(['optional-absent']);

    writeFileSync(
      join(dir, 'workflows/invoice.json'),
      JSON.stringify(workflow('={{ $json.body.record.name }}{{ $json.body.status }}'), null, 2),
    );
    out = [];
    expect(await run(['gen'], io())).toBe(0);
    // The budget fixes how many cases there are, so what changes is which ones:
    // a newly read path must now be varied.
    // The budget fixes how many cases there are, so what changes is which ones:
    // the newly read path is now varied properly, not just dropped.
    expect(kindsOn('body.status')).toContain('enum-value');
    expect(stdout()).toMatch(/added/i);
  });

  it('retires cases that no longer apply', async () => {
    setup('={{ $json.body.record.name }}{{ $json.body.status }}');
    await run(['gen'], io());

    expect(kindsOn('body.status')).toContain('enum-value');

    writeFileSync(join(dir, 'workflows/invoice.json'), JSON.stringify(workflow('={{ $json.body.record.name }}'), null, 2));
    out = [];
    await run(['gen'], io());
    // Same here: the count holds at the budget, and what goes is the richer
    // variation of the path the workflow stopped reading.
    expect(kindsOn('body.status')).toEqual(['optional-absent']);
    expect(stdout()).toMatch(/retired/i);
  });

  it('respects --max', async () => {
    setup();
    expect(await run(['gen', '--max', '3'], io())).toBe(0);
    expect(caseFiles()).toHaveLength(3);
  });

  it('--check passes when the cases are current', async () => {
    setup();
    await run(['gen'], io());
    out = [];
    expect(await run(['gen', '--check'], io())).toBe(0);
  });

  it('--check fails when they are stale, without writing anything', async () => {
    setup();
    await run(['gen'], io());
    const before = caseFiles().length;

    writeFileSync(
      join(dir, 'workflows/invoice.json'),
      JSON.stringify(workflow('={{ $json.body.record.name }}{{ $json.body.status }}'), null, 2),
    );
    out = [];
    expect(await run(['gen', '--check'], io())).toBe(1);
    expect(caseFiles().length).toBe(before);
  });

  it('reports plainly when there is nothing to generate', async () => {
    expect(await run(['gen'], io())).toBe(0);
    expect(stdout()).toMatch(/no contracts/i);
  });

  it('errors when the contract has no materialised shape', async () => {
    setup();
    writeFileSync(
      join(dir, 'workflows/invoice.contract.yaml'),
      'version: 1\ntrigger: Webhook\nsource:\n  kind: vendor\n  vendor: stripe\n  events:\n    - invoice.paid\n',
    );
    expect(await run(['gen'], io())).toBe(2);
    expect(err.join('\n')).toMatch(/contracts add|materialis/i);
  });
});
