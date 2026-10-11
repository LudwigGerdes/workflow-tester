import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '../../src/commands/run.js';

/**
 * `run --mock` against a real integration-mock, not a fake. workflow-tester does not
 * depend on integration-mock, so this runs only when INTEGRATION_MOCK_CLI points at a
 * built `integration-mock/packages/cli/dist/bin.js`; CI skips it.
 */
const cli = process.env['INTEGRATION_MOCK_CLI'];

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

const node = (name: string, type: string, typeVersion: number, parameters: Record<string, unknown>) =>
  ({ parameters, id: name, name, type, typeVersion, position: [0, 0] });

const workflow = {
  id: 'w',
  name: 'contact',
  nodes: [
    node('Webhook', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: 'w', options: {} }),
    {
      ...node('Get Contact', 'n8n-nodes-base.httpRequest', 4.2, {
        method: 'GET',
        url: '={{ "https://api.hubapi.com/crm/v3/objects/contacts/" + $json.body.id }}',
        options: {},
      }),
      onError: 'continueErrorOutput',
    },
    node('Alert', 'n8n-nodes-base.noOp', 1, {}),
    node('Pick', 'n8n-nodes-base.set', 3.4, {
      mode: 'manual',
      includeOtherFields: false,
      assignments: { assignments: [{ id: 'p', name: 'name', value: '={{ $json.properties.firstname }}', type: 'string' }] },
      options: {},
    }),
  ],
  connections: {
    Webhook: { main: [[{ node: 'Get Contact', type: 'main', index: 0 }]] },
    'Get Contact': { main: [[{ node: 'Pick', type: 'main', index: 0 }], [{ node: 'Alert', type: 'main', index: 0 }]] },
  },
};

describe.skipIf(cli === undefined)('run --mock against a real integration-mock', () => {
  let child: ChildProcess | undefined;
  let admin = 0;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'workflow-tester-mock-home-'));
    const port = await freePort();
    admin = await freePort();
    child = spawn(process.execPath, [cli!, 'start', '--foreground', '--port', String(port), '--admin-port', String(admin)], {
      env: { ...process.env, HOME: home, INTEGRATION_MOCK_HOME: join(home, '.integration-mock') },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i += 1) {
      const up = await fetch(`http://127.0.0.1:${admin}/state`).then((r) => r.ok, () => false);
      if (up) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('integration-mock did not start');
  }, 30_000);

  afterAll(() => {
    child?.kill();
  });

  it('seeds, faults and answers an HTTP Request node offline; then.calls judged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-tester-mock-e2e-'));
    mkdirSync(join(dir, 'workflows'), { recursive: true });
    mkdirSync(join(dir, '.workflow-tester/tests'), { recursive: true });
    writeFileSync(join(dir, 'workflows/contact.json'), JSON.stringify(workflow));
    writeFileSync(
      join(dir, '.workflow-tester/tests/contact.test.yaml'),
      `workflow: ../../workflows/contact.json
cases:
  - id: seeded
    given:
      packs: [hubspot]
      seed: { hubspot: { contacts: [{ id: '7', properties: { firstname: Ada } }] } }
    when: { trigger: webhook, payload: { body: { id: '7' } } }
    then:
      node.Pick.output[0].json.name: Ada
      calls: [{ service: hubspot, method: GET, count: 1 }]
      noUnmatched: true
  - id: down
    given:
      packs: [hubspot]
      faults: { hubspot: { status: 503 } }
    when: { trigger: webhook, payload: { body: { id: '7' } } }
    then:
      node.Alert.items: 1
      node.Alert.output[0].json.error: the mock answered 503
`,
    );
    const out: string[] = [];
    const code = await runCommand(['--mock', `http://127.0.0.1:${admin}`, '--format', 'json'], {
      cwd: dir,
      out: (s: string) => out.push(s),
      err: (s: string) => out.push(s),
    });
    const report = JSON.parse(out.join('\n')) as { outcomes: Array<{ caseId: string; status: string; message: string }> };
    // Every expectation held in both; the fault lands on the error branch, which
    // the classifier reports as a warning rather than a pass.
    expect(report.outcomes.map((o) => [o.caseId, o.status, o.message])).toEqual([
      ['down', 'warn', 'every expectation held'],
      ['seeded', 'pass', 'every expectation held'],
    ]);
    expect(code).toBe(0);
  });
});
