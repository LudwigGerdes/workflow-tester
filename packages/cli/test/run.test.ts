import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/index.js';

let dir: string;
let out: string[];
let err: string[];
const io = () => ({ cwd: dir, out: (s: string) => out.push(s), err: (s: string) => err.push(s) });
const stdout = () => out.join('\n');
const stderr = () => err.join('\n');

const workflow = {
  id: 'w', name: 'invoice',
  nodes: [
    { parameters: { httpMethod: 'POST', path: 'w', options: {} }, id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0] },
    {
      parameters: {
        mode: 'manual', includeOtherFields: false,
        assignments: { assignments: [{ id: 'a', name: 'name', value: '={{ $json.body.record.name }}', type: 'string' }] },
        options: {},
      },
      id: 'n2', name: 'Extract', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [220, 0],
    },
  ],
  connections: { Webhook: { main: [[{ node: 'Extract', type: 'main', index: 0 }]] } },
};

const setup = (): void => {
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  mkdirSync(join(dir, '.payload-contract/tests'), { recursive: true });
  writeFileSync(join(dir, 'workflows/invoice.json'), JSON.stringify(workflow, null, 2));
  writeFileSync(
    join(dir, '.payload-contract/tests/invoice.test.yaml'),
    `workflow: ../../workflows/invoice.json
cases:
  - id: good
    title: a name is present
    when:
      trigger: webhook
      payload:
        body:
          record:
            name: Ada
`,
  );
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'payload-contract-cli-run-'));
  out = [];
  err = [];
});

describe('run', () => {
  it('goes green on a webhook workflow that ends in Respond to Webhook', async () => {
    // The expectations `init` scaffolds, on the shape almost every webhook
    // workflow has. Neither could hold while Respond to Webhook was a boundary.
    mkdirSync(join(dir, 'workflows'), { recursive: true });
    mkdirSync(join(dir, '.payload-contract/tests'), { recursive: true });
    writeFileSync(
      join(dir, 'workflows/signup.json'),
      JSON.stringify({
        ...workflow,
        name: 'signup',
        nodes: [
          ...workflow.nodes,
          { parameters: { respondWith: 'firstIncomingItem', options: {} }, id: 'n3', name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [440, 0] },
        ],
        connections: {
          Webhook: { main: [[{ node: 'Extract', type: 'main', index: 0 }]] },
          Extract: { main: [[{ node: 'Respond', type: 'main', index: 0 }]] },
        },
      }, null, 2),
    );
    writeFileSync(
      join(dir, '.payload-contract/tests/signup.test.yaml'),
      `workflow: ../../workflows/signup.json
cases:
  - id: happy-path
    when:
      trigger: webhook
      payload:
        record:
          name: Ada
    then:
      execution.status: success
      node.Extract.items: 1
      node.Extract.output[0].json.name: Ada
      node.Respond.items: 1
`,
    );
    expect(await run(['run'], io())).toBe(0);
    expect(stdout()).toMatch(/1 passed, 0 failed, 0 warned/);
    expect(stdout()).not.toMatch(/needs a real execution/);
  });

  it('runs the suites and reports a clean pass', async () => {
    setup();
    expect(await run(['run'], io())).toBe(0);
    expect(stdout()).toMatch(/1 passed/);
  });

  it('exits 1 when a case fails', async () => {
    setup();
    writeFileSync(
      join(dir, '.payload-contract/tests/invoice.test.yaml'),
      `workflow: ../../workflows/invoice.json
cases:
  - id: expects-too-much
    when:
      trigger: webhook
      payload:
        body:
          record:
            name: Ada
    then:
      node.Extract.items: 99
`,
    );
    expect(await run(['run'], io())).toBe(1);
    expect(stdout()).toMatch(/failed/);
  });

  it('writes the last report where explain can find it', async () => {
    setup();
    await run(['run'], io());
    const report = join(dir, '.payload-contract/reports/last.json');
    expect(existsSync(report)).toBe(true);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({ summary: { pass: 1 } });
  });

  it.each(['json', 'junit', 'sarif', 'github-actions'])('renders --format %s', async (format) => {
    setup();
    expect(await run(['run', '--format', format], io())).toBe(0);
  });

  it('rejects an unknown format with exit 2', async () => {
    setup();
    expect(await run(['run', '--format', 'nonsense'], io())).toBe(2);
    expect(stderr()).toMatch(/nonsense/);
  });

  it('tightens to warnings with --fail-on warn', async () => {
    setup();
    // an assignment that resolves to nothing warns but does not fail
    writeFileSync(
      join(dir, '.payload-contract/tests/invoice.test.yaml'),
      `workflow: ../../workflows/invoice.json
cases:
  - id: missing-name
    when:
      trigger: webhook
      payload:
        body:
          record: {}
`,
    );
    expect(await run(['run'], io())).toBe(0);
    out = [];
    expect(await run(['run', '--fail-on', 'warn'], io())).toBe(1);
  });

  it('says plainly when there is nothing to run', async () => {
    expect(await run(['run'], io())).toBe(0);
    expect(stdout()).toMatch(/no cases|0 passed/i);
  });

});

describe('schema', () => {
  it('prints the test-file schema', async () => {
    expect(await run(['schema'], io())).toBe(0);
    const printed = JSON.parse(stdout()) as { $id: string };
    expect(printed.$id).toContain('payload-contract.test.schema.json');
  });
});

describe('init', () => {
  it('scaffolds a runnable example', async () => {
    expect(await run(['init'], io())).toBe(0);
    const example = join(dir, '.payload-contract/tests/example.test.yaml');
    expect(existsSync(example)).toBe(true);
    expect(readFileSync(example, 'utf8')).toMatch(/cases:/);
    expect(existsSync(join(dir, '.payload-contract/README.md'))).toBe(true);
  });

  it('refuses to overwrite what is already there', async () => {
    await run(['init'], io());
    out = [];
    expect(await run(['init'], io())).toBe(2);
    expect(stderr()).toMatch(/exists/i);
  });
});

describe('explain', () => {
  it('prints a case in the shape of a test file', async () => {
    setup();
    await run(['run'], io());
    out = [];
    expect(await run(['explain', 'good'], io())).toBe(0);
    expect(stdout()).toMatch(/id: good/);
    expect(stdout()).toMatch(/payload:/);
    expect(stdout()).toMatch(/status/);
  });

  it('reports an unknown case id', async () => {
    setup();
    await run(['run'], io());
    expect(await run(['explain', 'nope'], io())).toBe(2);
    expect(stderr()).toMatch(/nope/);
  });

  it('asks for a run first when there is no report', async () => {
    setup();
    expect(await run(['explain', 'good'], io())).toBe(2);
    expect(stderr()).toMatch(/payload-contract run/);
  });
});
