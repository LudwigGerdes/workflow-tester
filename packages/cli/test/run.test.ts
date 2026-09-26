import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/index.js';
import { runCommand } from '../src/commands/run.js';

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
  mkdirSync(join(dir, '.workflow-tester/tests'), { recursive: true });
  writeFileSync(join(dir, 'workflows/invoice.json'), JSON.stringify(workflow, null, 2));
  writeFileSync(
    join(dir, '.workflow-tester/tests/invoice.test.yaml'),
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
  dir = mkdtempSync(join(tmpdir(), 'workflow-tester-cli-run-'));
  out = [];
  err = [];
});

describe('run', () => {
  it('goes green on a webhook workflow that ends in Respond to Webhook', async () => {
    // The expectations `init` scaffolds, on the shape almost every webhook
    // workflow has. Neither could hold while Respond to Webhook was a boundary.
    mkdirSync(join(dir, 'workflows'), { recursive: true });
    mkdirSync(join(dir, '.workflow-tester/tests'), { recursive: true });
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
      join(dir, '.workflow-tester/tests/signup.test.yaml'),
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
      join(dir, '.workflow-tester/tests/invoice.test.yaml'),
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
    const report = join(dir, '.workflow-tester/reports/last.json');
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
      join(dir, '.workflow-tester/tests/invoice.test.yaml'),
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
    expect(printed.$id).toContain('workflow-tester.test.schema.json');
  });
});

describe('init', () => {
  it('scaffolds a runnable example', async () => {
    expect(await run(['init'], io())).toBe(0);
    const example = join(dir, '.workflow-tester/tests/example.test.yaml');
    expect(existsSync(example)).toBe(true);
    expect(readFileSync(example, 'utf8')).toMatch(/cases:/);
    expect(existsSync(join(dir, '.workflow-tester/README.md'))).toBe(true);
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
    expect(stderr()).toMatch(/workflow-tester run/);
  });
});

describe('run --live', () => {
  const writeSuite = (body: string): void => writeFileSync(join(dir, '.workflow-tester/tests/invoice.test.yaml'), body);
  const suite = `workflow: ../../workflows/invoice.json
cases:
  - id: faulted
    given:
      faults:
        acme: { status: 503, once: true }
    when:
      trigger: webhook
      payload: { body: { record: { name: 9 } } }
    then:
      execution.status: success
      calls:
        - { service: acme, method: POST, count: 1 }
      noUnmatched: true
  - id: plain
    when:
      trigger: webhook
      payload: { body: { record: { name: 9 } } }
    then:
      execution.status: success
`;
  const fakes = () => {
    const events: string[] = [];
    const mock = {
      enablePacks: async (ids: string[]) => void events.push(`enable ${ids.join(',')}`),
      setFault: async (service: string, spec: unknown) => void events.push(`fault ${service} ${JSON.stringify(spec)}`),
      clearFaults: async () => void events.push('clear'),
      resetStores: async () => void events.push('reset'),
      log: async () => [{ ts: 1, service: 'acme', method: 'POST', path: '/orders', status: 201, matchedRoute: 'create' }],
    };
    const runs: unknown[] = [];
    const runner = {
      run: async (input: { workflow: unknown; trigger: string; payload: unknown }) => {
        runs.push(input);
        return { execution: { id: '9', status: 'success', data: { resultData: { runData: {} } } }, id: '9' };
      },
    };
    return { mock, runner, events, runs };
  };

  it('runs the cases that need a mock on the instance, and folds them into the report', async () => {
    setup();
    writeSuite(suite);
    const { mock, runner, events, runs } = fakes();
    const code = await runCommand(['--live', '--instance', 'https://n8n.example.test', '--format', 'json'], { ...io(), env: { N8N_API_KEY: 'k' } }, { mock, runner });
    expect(code).toBe(0);
    const report = JSON.parse(stdout()) as { outcomes: Array<{ caseId: string; mode: string; status: string; executionId?: string }>; summary: { pass: number; needsExecution: number } };
    expect(report.outcomes.map((o) => [o.caseId, o.mode, o.status])).toEqual([['faulted', 'live', 'pass'], ['plain', 'offline', 'pass']]);
    expect(report.outcomes[0]?.executionId).toBe('9');
    expect(report.summary).toMatchObject({ pass: 2, needsExecution: 0 });
    expect(events).toEqual(['clear', 'reset', 'fault acme {"status":503,"once":true}']);
    expect((runs[0] as { trigger: string; payload: unknown }).trigger).toBe('Webhook');
  });

  it('without --live the same case is reported as needing one', async () => {
    setup();
    writeSuite(suite);
    expect(await run(['run', '--format', 'json'], io())).toBe(0);
    const report = JSON.parse(stdout()) as { summary: { needsExecution: number; pass: number } };
    expect(report.summary).toMatchObject({ needsExecution: 1, pass: 1 });
  });

  it('refuses --live without an instance', async () => {
    setup();
    writeSuite(suite);
    expect(await runCommand(['--live'], io(), fakes())).toBe(2);
    expect(err.join('\n')).toMatch(/--live runs cases on your instance/);
  });
});
