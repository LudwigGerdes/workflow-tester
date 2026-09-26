import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderReport } from '../src/reporters/index.js';
import { runTier1 } from '../src/run.js';

let dir: string;

/** Webhook → Set (reads `record.name` only) → IF (name not empty) → NoOp */
const workflow = {
  id: 'w',
  name: 'invoice',
  nodes: [
    { parameters: { httpMethod: 'POST', path: 'w', options: {} }, id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0] },
    {
      parameters: {
        mode: 'manual', includeOtherFields: false,
        // typed `number` because the IF below compares numerically under strict
        // type validation — a string here is a type mismatch, not a pass
        assignments: { assignments: [{ id: 'a', name: 'name', value: '={{ $json.body.record.name }}', type: 'number' }] },
        options: {},
      },
      id: 'n2', name: 'Extract', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [220, 0],
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [{ id: 'c', leftValue: '={{ $json.name }}', rightValue: 5, operator: { type: 'number', operation: 'gt' } }],
          combinator: 'and',
        },
        options: {},
      },
      id: 'n3', name: 'Check', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [440, 0],
    },
    { parameters: {}, id: 'n4', name: 'Yes', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [660, 0] },
  ],
  connections: {
    Webhook: { main: [[{ node: 'Extract', type: 'main', index: 0 }]] },
    Extract: { main: [[{ node: 'Check', type: 'main', index: 0 }]] },
    Check: { main: [[{ node: 'Yes', type: 'main', index: 0 }], []] },
  },
};

/** Same flow, but with an HTTP call in the middle. */
const withBoundary = {
  ...workflow,
  nodes: [
    ...workflow.nodes.slice(0, 2),
    { parameters: { url: 'https://example.invalid', options: {} }, id: 'h', name: 'Call API', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [440, 0] },
  ],
  connections: {
    Webhook: { main: [[{ node: 'Extract', type: 'main', index: 0 }]] },
    Extract: { main: [[{ node: 'Call API', type: 'main', index: 0 }]] },
  },
};

const setup = (wf: unknown = workflow): void => {
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  mkdirSync(join(dir, '.workflow-tester/tests'), { recursive: true });
  writeFileSync(join(dir, 'workflows/invoice.json'), JSON.stringify(wf, null, 2));
};

const writeSuite = (body: string): void =>
  writeFileSync(join(dir, '.workflow-tester/tests/invoice.test.yaml'), body);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-tester-run-'));
});

const run = (options = {}) => runTier1({ dir, sandbox: false, ...options });

describe('runTier1', () => {
  it('passes a case whose expressions all resolve', async () => {
    setup();
    writeSuite(`workflow: ../../workflows/invoice.json
cases:
  - id: has-name
    title: record.name present
    when:
      trigger: webhook
      payload:
        body:
          record:
            name: 9
`);
    const report = await run();
    expect(report.summary.pass).toBe(1);
    expect(report.summary.fail).toBe(0);
  });

  it('catches the variant the workflow does not handle, naming node and expression', async () => {
    setup();
    // the workflow reads `record.name`; this payload has `record.details.name`
    writeSuite(`workflow: ../../workflows/invoice.json
cases:
  - id: details-branch
    title: record.details.name instead
    when:
      trigger: webhook
      payload:
        body:
          record:
            details:
              name: 9
`);
    const report = await run();
    expect(report.summary.fail).toBe(1);
    const [outcome] = report.outcomes;
    expect(outcome?.node).toBe('Check');
    expect(outcome?.message).toMatch(/undefined/i);
  });

  it('wraps a bare payload for a webhook trigger', async () => {
    setup();
    writeSuite(`workflow: ../../workflows/invoice.json
cases:
  - id: bare
    when:
      trigger: webhook
      payload:
        record:
          name: 9
`);
    // the payload is just the body; wrapping it is what lets a hand-written
    // test target `$json.body.…` without writing the envelope out by hand
    const report = await run();
    expect(report.summary.pass).toBe(1);
  });

  it('counts a boundary as needing a real execution, not as a failure', async () => {
    setup(withBoundary);
    writeSuite(`workflow: ../../workflows/invoice.json
cases:
  - id: stops
    when:
      trigger: webhook
      payload:
        body:
          record:
            name: 9
`);
    const report = await run();
    expect(report.summary.needsExecution).toBe(1);
    expect(report.summary.fail).toBe(0);
    expect(report.outcomes[0]?.message).toMatch(/Call API/);
  });

  it('evaluates declared expectations', async () => {
    setup();
    writeSuite(`workflow: ../../workflows/invoice.json
cases:
  - id: expects
    when:
      trigger: webhook
      payload:
        body:
          record:
            name: 9
    then:
      execution.status: success
      node.Extract.items: 1
      node.Extract.output[0].json.name: 9
`);
    const report = await run();
    expect(report.summary.pass).toBe(1);
    expect(report.outcomes[0]?.assertions.every((a) => a.status === 'pass')).toBe(true);
  });

  it('fails a case whose workflow is missing rather than crashing', async () => {
    mkdirSync(join(dir, '.workflow-tester/tests'), { recursive: true });
    writeSuite(`workflow: ../../workflows/nope.json
cases:
  - id: x
    when:
      payload: {}
`);
    const report = await run();
    expect(report.summary.fail).toBe(1);
    expect(report.outcomes[0]?.message).toMatch(/workflow not found/);
  });

  it('produces identical output at any concurrency', async () => {
    setup();
    writeSuite(`workflow: ../../workflows/invoice.json
cases:
${Array.from({ length: 8 }, (_v, i) => `  - id: case-${i}\n    when:\n      trigger: webhook\n      payload:\n        body:\n          record:\n            name: ${i}\n`).join('')}`);
    const serial = await run({ concurrency: 1 });
    const parallel = await run({ concurrency: 8 });
    expect(parallel.outcomes.map((o) => [o.caseId, o.status])).toEqual(
      serial.outcomes.map((o) => [o.caseId, o.status]),
    );
  });

  it('runs through the sandbox by default', async () => {
    setup();
    writeSuite(`workflow: ../../workflows/invoice.json
cases:
  - id: sandboxed
    when:
      trigger: webhook
      payload:
        body:
          record:
            name: 9
`);
    const report = await runTier1({ dir });
    expect(report.summary.pass).toBe(1);
  }, 60_000);

  it('narrows to hand-written tests or generated cases', async () => {
    setup();
    writeSuite(`workflow: ../../workflows/invoice.json
cases:
  - id: written
    when:
      trigger: webhook
      payload: { body: { record: { name: 9 } } }
`);
    expect((await run({ only: 'generated' })).outcomes).toHaveLength(0);
    expect((await run({ only: 'tests' })).outcomes).toHaveLength(1);
  });
});

describe('reporters', () => {
  const report = {
    suites: 1,
    summary: { pass: 1, fail: 1, warn: 0, needsExecution: 1, durationMs: 12 },
    outcomes: [
      { caseId: 'aaa', title: 'a passing case', workflow: 'workflows/invoice.json', status: 'pass' as const, tier: 1 as const, message: 'ok', assertions: [] },
      {
        caseId: 'bbb', title: 'a failing case', workflow: 'workflows/invoice.json',
        status: 'fail' as const, tier: 1 as const, node: 'Check', parameter: 'conditions',
        resolvedPath: 'body.record.name → undefined', message: 'condition undecidable',
        assertions: [{ path: 'node.Check.items', status: 'fail' as const, expected: 1, actual: 0 }],
      },
      {
        caseId: 'ccc', title: 'a deferred case', workflow: 'workflows/invoice.json',
        status: 'needs-execution' as const, tier: 1 as const, node: 'Call API', message: 'verified up to Call API',
        assertions: [{ path: 'calls', status: 'needs-execution' as const, message: 'needs a real execution' }],
      },
    ],
  };

  it('renders stylish output with the resolved-path chain', async () => {
    const text = await renderReport(report, 'stylish');
    expect(text).toContain('workflows/invoice.json');
    expect(text).toContain('a failing case');
    expect(text).toContain('body.record.name → undefined');
    expect(text).toContain('at Check → conditions');
    expect(text).toContain('needs a real execution: 1');
  });

  it('renders json containing the whole report', async () => {
    const parsed = JSON.parse(await renderReport(report, 'json')) as typeof report;
    expect(parsed.summary.fail).toBe(1);
    expect(parsed.outcomes).toHaveLength(3);
  });

  it('renders junit with needs-tier2 as skipped', async () => {
    const xml = await renderReport(report, 'junit');
    expect(xml).toContain('<testsuites name="workflow-tester"');
    expect(xml).toContain('<testsuite name="workflows/invoice.json"');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('skipped="1"');
    expect(xml).toContain('<skipped message="verified up to Call API"/>');
  });

  it('renders sarif with a file-level region when no line mapper is present', async () => {
    const sarif = JSON.parse(await renderReport(report, 'sarif')) as {
      runs: Array<{ results: Array<{ level: string; locations: Array<{ physicalLocation: { artifactLocation: { uri: string }; region?: unknown } }> }> }>;
    };
    const results = sarif.runs[0]?.results ?? [];
    // only the failure and warning are findings; passes and deferrals are not
    expect(results).toHaveLength(1);
    expect(results[0]?.level).toBe('error');
    expect(results[0]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe('workflows/invoice.json');
    expect(results[0]?.locations[0]?.physicalLocation.region).toBeUndefined();
  });

  it('renders github-actions annotations', async () => {
    const text = await renderReport(report, 'github-actions');
    expect(text).toContain('::error file=workflows/invoice.json,title=a failing case::');
  });
});

describe('given.pinData', () => {
  /** Boundary flow extended: Call API → Use (reads the call's output). */
  const pastBoundary = {
    ...withBoundary,
    nodes: [
      ...withBoundary.nodes,
      {
        parameters: {
          mode: 'manual', includeOtherFields: false,
          assignments: { assignments: [{ id: 'u', name: 'plan', value: '={{ $json.plan }}', type: 'string' }] },
          options: {},
        },
        id: 'n5', name: 'Use', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [660, 0],
      },
    ],
    connections: {
      ...withBoundary.connections,
      'Call API': { main: [[{ node: 'Use', type: 'main', index: 0 }]] },
    },
  };

  it('stands in for a boundary node so the walk carries on past it', async () => {
    setup(pastBoundary);
    writeSuite(`workflow: ../../workflows/invoice.json
cases:
  - id: pinned
    given:
      pinData:
        Call API:
          - json: { plan: pro }
    when:
      trigger: webhook
      payload:
        body:
          record:
            name: 9
    then:
      execution.status: success
      node.Use.output[0].json.plan: pro
`);
    const report = await run();
    expect(report.summary.pass).toBe(1);
    expect(report.summary.needsExecution).toBe(0);
    expect(report.outcomes[0]?.substituted).toEqual(['Call API']);
  });

  it('a file-level given applies to every case, and a case may pin more', async () => {
    setup(pastBoundary);
    writeSuite(`workflow: ../../workflows/invoice.json
given:
  pinData:
    Call API:
      - json: { plan: free }
cases:
  - id: file-level
    when:
      trigger: webhook
      payload: { body: { record: { name: 9 } } }
    then:
      node.Use.output[0].json.plan: free
  - id: case-level
    given:
      pinData:
        Call API:
          - json: { plan: pro }
    when:
      trigger: webhook
      payload: { body: { record: { name: 9 } } }
    then:
      node.Use.output[0].json.plan: pro
`);
    const report = await run();
    expect(report.summary.pass).toBe(2);
  });

  it('fails a case whose pinData names a node the workflow does not have', async () => {
    setup(pastBoundary);
    writeSuite(`workflow: ../../workflows/invoice.json
cases:
  - id: typo
    given:
      pinData:
        Call APIs:
          - json: { plan: pro }
    when:
      trigger: webhook
      payload: { body: { record: { name: 9 } } }
`);
    const report = await run();
    expect(report.summary.fail).toBe(1);
    expect(report.outcomes[0]?.message).toMatch(/pinData.*"Call APIs".*not in/s);
  });
});
