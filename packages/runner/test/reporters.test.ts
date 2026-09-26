import { describe, expect, it } from 'vitest';
import { renderReport } from '../src/reporters/index.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { RunReport } from '../src/run.js';

/** Places `Check` and nothing else, so the fallback path is exercised too. */
const report: RunReport = {
  suites: 1,
  startedAt: '2026-09-25T10:00:00.000Z',
  summary: { pass: 0, fail: 1, warn: 1, needsExecution: 0, durationMs: 5 },
  nodeTypes: { version: '2.10.0', exact: true },
  outcomes: [
    {
      caseId: 'fails', title: 'a failing case', workflow: 'workflows/invoice.json',
      status: 'fail', mode: 'offline', node: 'Check', parameter: 'conditions',
      message: 'condition undecidable', assertions: [], durationMs: 3,
    },
    {
      caseId: 'warns', title: 'a warning case', workflow: 'workflows/invoice.json',
      status: 'warn', mode: 'offline', node: 'Somewhere Else',
      message: 'an assignment went missing', assertions: [], durationMs: 2,
    },
  ],
};

interface Sarif {
  runs: Array<{
    tool: {
      driver: {
        name: string;
        version?: string;
        rules?: Array<{ id: string; shortDescription: { text: string }; helpUri?: string }>;
      };
    };
    invocations?: Array<{ startTimeUtc: string; endTimeUtc: string; executionSuccessful: boolean }>;
    properties?: { nodeTypes?: { version: string; exact: boolean } };
    results: Array<{
      ruleId: string;
      partialFingerprints?: Record<string, string>;
      locations: Array<{
        physicalLocation: {
          artifactLocation: { uri: string };
          region?: { startLine: number; startColumn?: number };
        };
        logicalLocations?: Array<{ name: string; kind: string }>;
      }>;
    }>;
  }>;
}

const sarif = async (options?: Parameters<typeof renderReport>[2]): Promise<Sarif> =>
  JSON.parse(await renderReport(report, 'sarif', options)) as Sarif;

const regionOf = (doc: Sarif, index: number) =>
  doc.runs[0]?.results[index]?.locations[0]?.physicalLocation.region;

describe('SARIF regions', () => {
  it('emits a file-level region when the workflow file is not readable', async () => {
    expect(regionOf(await sarif({ root: '/nowhere' }), 0)).toBeUndefined();
    expect(regionOf(await sarif({ root: '/nowhere' }), 1)).toBeUndefined();
  });

  it('points at the line that names the node when the workflow file is readable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-tester-sarif-'));
    mkdirSync(join(root, 'workflows'), { recursive: true });
    writeFileSync(
      join(root, 'workflows/invoice.json'),
      ['{', '  "nodes": [', '    {', '      "name": "Check",', '      "type": "n8n-nodes-base.if"', '    }', '  ]', '}'].join('\n'),
    );
    const doc = await sarif({ root });
    expect(regionOf(doc, 0)).toEqual({ startLine: 4 });
    // "Somewhere Else" is not in the file: file-level, not a guess.
    expect(regionOf(doc, 1)).toBeUndefined();
  });

  it('keeps the artifact URI repo-relative', async () => {
    const doc = await sarif();
    for (const index of [0, 1]) {
      expect(doc.runs[0]?.results[index]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe(
        'workflows/invoice.json',
      );
    }
  });
});

describe('SARIF provenance', () => {
  it('carries the real tool version, the rules, and the node as a logical location', async () => {
    const doc = await sarif({ root: '/nowhere', version: '0.2.0' });
    const driver = doc.runs[0]?.tool.driver;
    expect(driver?.version).toBe('0.2.0');
    expect(driver?.rules?.map((rule) => rule.id)).toEqual([
      'workflow-tester/case-failed',
      'workflow-tester/case-warned',
    ]);
    for (const rule of driver?.rules ?? []) {
      expect(rule.shortDescription.text).not.toBe('');
      expect(rule.helpUri).toBe('https://workflowtools.dev/workflow-tester/writing-tests');
    }
    expect(doc.runs[0]?.results[0]?.locations[0]?.logicalLocations).toEqual([
      { name: 'Check', kind: 'node' },
    ]);
  });

  it('fingerprints each result by workflow, case and node so re-runs match up', async () => {
    const doc = await sarif({ root: '/nowhere' });
    const expected = createHash('sha256')
      .update('workflows/invoice.json\0fails\0Check')
      .digest('hex');
    expect(doc.runs[0]?.results[0]?.partialFingerprints).toEqual({ 'workflow-tester/v1': expected });
  });

  it('records when the run started and ended, and which node descriptions it used', async () => {
    const doc = await sarif({ root: '/nowhere' });
    expect(doc.runs[0]?.invocations).toEqual([
      {
        startTimeUtc: '2026-09-25T10:00:00.000Z',
        endTimeUtc: '2026-09-25T10:00:00.005Z',
        executionSuccessful: false,
      },
    ]);
    expect(doc.runs[0]?.properties?.nodeTypes).toEqual({ version: '2.10.0', exact: true });
  });
});

describe('JUnit', () => {
  const twoWorkflows: RunReport = {
    ...report,
    summary: { pass: 1, fail: 1, warn: 1, needsExecution: 1, durationMs: 10 },
    outcomes: [
      ...report.outcomes,
      {
        caseId: 'passes', title: 'a passing case', workflow: 'workflows/signup.json',
        status: 'pass', mode: 'offline', message: 'ok', assertions: [], durationMs: 4,
      },
      {
        caseId: 'waits', title: 'a deferred case', workflow: 'workflows/signup.json',
        status: 'needs-execution', mode: 'offline', message: 'verified up to Call API', assertions: [], durationMs: 1,
      },
    ],
  };

  it('writes one testsuite per workflow with its own counts and time', async () => {
    const xml = await renderReport(twoWorkflows, 'junit', { version: '0.2.0' });
    expect(xml).toContain('<testsuites name="workflow-tester" tests="4" failures="1" skipped="1" time="0.010"');
    expect(xml).toContain('<testsuite name="workflows/invoice.json" tests="2" failures="1" skipped="0" time="0.005">');
    expect(xml).toContain('<testsuite name="workflows/signup.json" tests="2" failures="0" skipped="1" time="0.005">');
    expect(xml).toContain('<testcase name="a failing case" classname="workflows/invoice.json" time="0.003">');
    expect(xml).toContain('<testcase name="a passing case" classname="workflows/signup.json" time="0.004"/>');
    expect(xml).toContain('<skipped message="verified up to Call API"/>');
  });

  it('names the tool version and node descriptions in properties', async () => {
    const xml = await renderReport(twoWorkflows, 'junit', { version: '0.2.0' });
    expect(xml).toContain('<property name="workflow-tester.version" value="0.2.0"/>');
    expect(xml).toContain('<property name="n8nVersion" value="2.10.0"/>');
    expect(xml).toContain('<property name="nodeTypes.version" value="2.10.0"/>');
    expect(xml).toContain('<property name="exact" value="true"/>');
    expect(xml).toContain('timestamp="2026-09-25T10:00:00.000Z"');
  });

  it('tolerates a report without timings, as an older last.json has none', async () => {
    const bare: RunReport = {
      suites: 1,
      summary: { pass: 1, fail: 0, warn: 0, needsExecution: 0, durationMs: 0 },
      outcomes: [{ caseId: 'x', workflow: 'w.json', status: 'pass', mode: 'offline', message: 'ok', assertions: [] }],
    };
    const xml = await renderReport(bare, 'junit');
    expect(xml).toContain('<testcase name="x" classname="w.json" time="0.000"/>');
    expect(xml).not.toContain('workflow-tester.version');
  });
});

describe('the node-type version note', () => {
  it('says once, at the end, when the descriptions were for another version', async () => {
    const withNote: RunReport = {
      ...report,
      nodeTypes: {
        version: '2.10.0',
        exact: false,
        note: 'n8n 2.38.3 is not bundled; using the nearest older 2.10.0',
      },
    };
    const text = await renderReport(withNote, 'stylish', { root: '/repo' });
    expect(text).toMatch(/2\.38\.3/);
    expect(text.match(/not bundled/g)?.length).toBe(1);
  });

  it('says nothing when the version was exact', async () => {
    const exact: RunReport = { ...report, nodeTypes: { version: '2.38.3', exact: true } };
    const text = await renderReport(exact, 'stylish', { root: '/repo' });
    expect(text).not.toMatch(/not bundled|nearest/);
  });
});

describe('stylish and structure findings', () => {
  /**
   * A case can hold every expectation and still be marked `!`, because the
   * structural check found a read of a field the payload never carries. That
   * reason used to live only in `--format json`, so the stylish line read as
   * "warned, every expectation held" with nothing to explain the contradiction.
   */
  const warned: RunReport = {
    suites: 1,
    summary: { pass: 0, fail: 0, warn: 1, needsExecution: 0, durationMs: 5 },
    outcomes: [
      {
        caseId: 'nested', title: 'pro user with nested profile', workflow: 'workflows/signup.json',
        status: 'warn', mode: 'offline', message: 'every expectation held',
        assertions: [{ path: 'execution.status', status: 'pass', expected: 'success', actual: 'success' }],
        structure: [
          {
            kind: 'absent-field', severity: 'warn', at: 'body.name', message: '"name" is not produced here',
            node: 'Normalize', parameter: 'assignments.assignments[1].value', chain: 'body.name',
          },
        ],
      },
    ],
  };

  it('prints each structure finding under the case, with where it was read', async () => {
    const text = await renderReport(warned, 'stylish');
    expect(text).toContain('  ! pro user with nested profile  every expectation held');
    expect(text).toContain('      ! "name" is not produced here');
    expect(text).toContain('at Normalize → assignments.assignments[1].value');
  });
});
