import { describe, expect, it } from 'vitest';
import { renderReport } from '../src/reporters/index.js';
import type { SourceMapAdapter } from '../src/reporters/source-map.js';
import type { RunReport } from '../src/run.js';

/** Places `Check` and nothing else, so the fallback path is exercised too. */
const report: RunReport = {
  suites: 1,
  summary: { pass: 0, fail: 1, warn: 1, needsExecution: 0, durationMs: 5 },
  outcomes: [
    {
      caseId: 'fails', title: 'a failing case', workflow: 'workflows/invoice.json',
      status: 'fail', tier: 1, node: 'Check', parameter: 'conditions',
      message: 'condition undecidable', assertions: [],
    },
    {
      caseId: 'warns', title: 'a warning case', workflow: 'workflows/invoice.json',
      status: 'warn', tier: 1, node: 'Somewhere Else',
      message: 'an assignment went missing', assertions: [],
    },
  ],
};

interface Sarif {
  runs: Array<{
    results: Array<{
      locations: Array<{
        physicalLocation: {
          artifactLocation: { uri: string };
          region?: { startLine: number; startColumn: number };
        };
      }>;
    }>;
  }>;
}

const sarif = async (options?: Parameters<typeof renderReport>[2]): Promise<Sarif> =>
  JSON.parse(await renderReport(report, 'sarif', options)) as Sarif;

const regionOf = (doc: Sarif, index: number) =>
  doc.runs[0]?.results[index]?.locations[0]?.physicalLocation.region;

describe('SARIF regions', () => {
  it('emits a file-level region, because payload-contract does not read the workflow file', async () => {
    expect(regionOf(await sarif(), 0)).toBeUndefined();
    expect(regionOf(await sarif(), 1)).toBeUndefined();
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
        status: 'warn', tier: 1, message: 'every expectation held',
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
