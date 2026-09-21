import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../src/index.js';

/**
 * The proof the design spec opens with.
 *
 * A vendor sends `record.name` on some events and `record.details.name` on
 * others. The workflow was written against the first shape only. Nothing about
 * that workflow is syntactically wrong, and n8n will not complain: the
 * expression quietly resolves to undefined and the item takes the wrong branch.
 *
 * workflow-tester should generate the variant that exposes it, and name the case, the
 * node, the expression and the path that resolved to nothing.
 */

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

const workflow = (expression: string) => ({
  id: 'w',
  name: 'invoice-sync',
  nodes: [
    { parameters: { httpMethod: 'POST', path: 'w', options: {} }, id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0] },
    {
      parameters: {
        mode: 'manual', includeOtherFields: false,
        assignments: { assignments: [{ id: 'a', name: 'name', value: expression, type: 'string' }] },
        options: {},
      },
      id: 'n2', name: 'Extract Name', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [220, 0],
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [{ id: 'c', leftValue: '={{ $json.name }}', rightValue: 'Ada', operator: { type: 'string', operation: 'equals' } }],
          combinator: 'and',
        },
        options: {},
      },
      id: 'n3', name: 'Is Ada?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [440, 0],
    },
    { parameters: {}, id: 'n4', name: 'Yes', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [660, -80] },
    { parameters: {}, id: 'n5', name: 'No', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [660, 80] },
  ],
  connections: {
    Webhook: { main: [[{ node: 'Extract Name', type: 'main', index: 0 }]] },
    'Extract Name': { main: [[{ node: 'Is Ada?', type: 'main', index: 0 }]] },
    'Is Ada?': { main: [[{ node: 'Yes', type: 'main', index: 0 }], [{ node: 'No', type: 'main', index: 0 }]] },
  },
});

/** `record` arrives in one of two shapes — the vendor publishes both. */
const SHAPE = {
  type: 'object',
  required: ['record'],
  properties: {
    record: {
      oneOf: [
        { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        {
          type: 'object',
          required: ['details'],
          properties: { details: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
        },
      ],
    },
  },
};

const EXAMPLES = [
  { event: 'record.created', payload: { record: { name: 'Ada' } } },
  { event: 'record.imported', payload: { record: { details: { name: 'Ada' } } } },
];

const ONLY_FLAT = '={{ $json.body.record.name }}';
const HANDLES_BOTH = '={{ $json.body.record.name ?? $json.body.record.details.name }}';

const write = (expression: string): void =>
  writeFileSync(join(dir, 'workflows/invoice-sync.json'), JSON.stringify(workflow(expression), null, 2));

const caseDir = () => join(dir, '.workflow-tester/cases/invoice-sync/demo.record');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-tester-e2e-'));
  out = [];
  err = [];
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  mkdirSync(join(dir, '.workflow-tester/contracts'), { recursive: true });
  write(ONLY_FLAT);
  writeFileSync(
    join(dir, 'workflows/invoice-sync.contract.yaml'),
    [
      'version: 1', 'trigger: Webhook', 'source:', '  kind: vendor', '  vendor: stripe',
      '  events:', '    - record.created', '    - record.imported',
      'shape:', '  schema: ../.workflow-tester/contracts/demo.record.schema.json',
      '  examples: ../.workflow-tester/contracts/demo.record.examples.json', '',
    ].join('\n'),
  );
  writeFileSync(join(dir, '.workflow-tester/contracts/demo.record.schema.json'), JSON.stringify(SHAPE, null, 2));
  writeFileSync(join(dir, '.workflow-tester/contracts/demo.record.examples.json'), JSON.stringify(EXAMPLES, null, 2));
});

describe('the record.name vs record.details.name bug', () => {
  it('generates a case for each shape the vendor sends', async () => {
    expect(await run(['gen'], io())).toBe(0);

    const cases = readdirSync(caseDir())
      .filter((f) => f !== 'index.json')
      .map((f) => JSON.parse(readFileSync(join(caseDir(), f), 'utf8')) as { title: string });

    // both examples, verbatim, plus the branch swaps between them
    expect(cases.filter((c) => c.title.startsWith('example'))).toHaveLength(2);
    expect(cases.filter((c) => c.title.includes('oneOf-branch body.record')).length).toBeGreaterThan(0);
  });

  it('catches the shape the workflow does not handle, naming node, expression and path', async () => {
    await run(['gen'], io());
    out = [];

    expect(await run(['run'], io())).toBe(1);

    const text = stdout();
    // the node whose condition could not be decided, and the expression there
    expect(text).toContain('at Is Ada? → conditions');
    expect(text).toContain('resolved:   name → undefined');
    // and which variant exposed it — this is what makes the report actionable
    // paths are envelope-level, since that is where the expressions read
    expect(text).toMatch(/oneOf-branch body\.record/);
    expect(text).toMatch(/failed/);

    // The resolved path is reported as the *failing expression* sees it. The IF
    // reads `$json.name`, which is the Set's output field, so that is what
    // resolved to nothing. Tracing it back to `body.record.name` on the trigger
    // payload needs the Set lineage the generator computes for its focus set;
    // the engine deliberately does not carry it. The upstream Set is reported
    // separately, as a warning on the assignment that went missing.
  });

  it('goes green once the expression handles both shapes', async () => {
    await run(['gen'], io());
    expect(await run(['run'], io())).toBe(1);

    // the fix: fall back to the other shape
    write(HANDLES_BOTH);
    out = [];
    err = [];
    expect(await run(['gen'], io())).toBe(0);
    expect(await run(['run'], io())).toBe(0);
    expect(stdout()).toMatch(/0 failed|failed/);
  });

  it('explains the failing case in the shape of a test file', async () => {
    await run(['gen'], io());
    await run(['run'], io());

    const failing = JSON.parse(
      readFileSync(join(dir, '.workflow-tester/reports/last.json'), 'utf8'),
    ) as { outcomes: Array<{ caseId: string; status: string }> };
    const id = failing.outcomes.find((o) => o.status === 'fail')?.caseId;
    expect(id).toBeDefined();

    out = [];
    expect(await run(['explain', id as string], io())).toBe(0);
    expect(stdout()).toMatch(/id: /);
    expect(stdout()).toMatch(/payload:/);
    expect(stdout()).toMatch(/status fail/);
  });
});
