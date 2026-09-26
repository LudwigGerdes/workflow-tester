import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SuiteError, loadSuites, testSchema } from '../src/load.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-tester-load-'));
  mkdirSync(join(dir, '.workflow-tester/tests'), { recursive: true });
  mkdirSync(join(dir, '.workflow-tester/generated'), { recursive: true });
});

const writeTest = (name: string, body: string): void => {
  writeFileSync(join(dir, '.workflow-tester/tests', name), body);
};

const VALID = `workflow: ../../workflows/invoice.json
cases:
  - id: happy
    title: a paid invoice
    when:
      trigger: webhook
      payload:
        body:
          id: inv_1
    then:
      execution.status: success
      node.Extract.items: 1
`;

describe('loadSuites', () => {
  it('loads a hand-written suite', async () => {
    writeTest('invoice.test.yaml', VALID);
    const { tests, generated } = await loadSuites(dir);
    expect(generated).toEqual([]);
    expect(tests).toHaveLength(1);
    expect(tests[0]?.workflow).toBe('../../workflows/invoice.json');
    expect(tests[0]?.cases[0]).toMatchObject({
      id: 'happy',
      title: 'a paid invoice',
      when: { trigger: 'webhook', payload: { body: { id: 'inv_1' } } },
    });
    expect(tests[0]?.cases[0]?.then?.['node.Extract.items']).toBe(1);
  });

  it('reports where a suite is invalid, with a line number', async () => {
    // The owner's schema is a oneOf: a `cases:` list, or a top-level `when`.
    // A file with neither satisfies neither branch.
    writeTest(
      'broken.test.yaml',
      `workflow: ../../workflows/invoice.json
instance: dev
`,
    );
    const error = await loadSuites(dir).then(
      () => { throw new Error('expected a rejection'); },
      (e: unknown) => e as SuiteError,
    );
    expect(error).toBeInstanceOf(SuiteError);
    expect(error.issues.length).toBeGreaterThan(0);
    expect(error.issues[0]?.line).toBeGreaterThan(0);
  });

  it('rejects a suite with no cases', async () => {
    writeTest('empty.test.yaml', 'workflow: ../../workflows/invoice.json\ncases: []\n');
    await expect(loadSuites(dir)).rejects.toBeInstanceOf(SuiteError);
  });

  it('rejects unknown keys rather than silently ignoring them', async () => {
    writeTest('typo.test.yaml', `${VALID}unexpected: true\n`);
    const error = await loadSuites(dir).then(
      () => { throw new Error('expected a rejection'); },
      (e: unknown) => e as SuiteError,
    );
    expect(error.issues[0]?.message).toMatch(/unexpected/);
  });

  it('reports a YAML syntax error against its line', async () => {
    writeTest('bad-yaml.test.yaml', 'workflow: x\ncases:\n  - id: a\n   when: {}\n');
    await expect(loadSuites(dir)).rejects.toBeInstanceOf(SuiteError);
  });

  it('accepts tier-2 assertions without running them', async () => {
    writeTest(
      'tier2.test.yaml',
      `workflow: ../../workflows/invoice.json
cases:
  - id: calls
    when:
      payload: {}
    then:
      calls:
        - service: slack
      noUnmatched: true
`,
    );
    const { tests } = await loadSuites(dir);
    expect(tests[0]?.cases[0]?.then?.noUnmatched).toBe(true);
  });

  it('wraps generated cases into a synthetic suite', async () => {
    const caseDir = join(dir, '.workflow-tester/cases/invoice/stripe.invoice');
    mkdirSync(caseDir, { recursive: true });
    for (const [id, title] of [['aaa1', 'example #0'], ['bbb2', 'optional-absent body.email']]) {
      writeFileSync(
        join(caseDir, `${id}.json`),
        JSON.stringify({ id, title, tags: ['single'], payload: { body: { n: 1 } }, provenance: { exampleIndex: 0, mutations: [] } }),
      );
    }
    writeFileSync(join(caseDir, 'index.json'), JSON.stringify({ cases: [], stats: {}, focus: [], inputs: {} }));

    const { generated } = await loadSuites(dir);
    expect(generated).toHaveLength(1);
    expect(generated[0]?.workflow).toMatch(/workflows\/invoice\.json$/);
    expect(generated[0]?.cases.map((c) => c.id).sort()).toEqual(['aaa1', 'bbb2']);
    expect(generated[0]?.cases[0]?.when.payload).toEqual({ body: { n: 1 } });
    // index.json is not a case
    expect(generated[0]?.cases.some((c) => c.id === 'index')).toBe(false);
  });

  it('returns nothing when the directory has no suites at all', async () => {
    const { tests, generated } = await loadSuites(dir);
    expect(tests).toEqual([]);
    expect(generated).toEqual([]);
  });

  it('publishes the schema it validates against', () => {
    // $id. That identity is the point: it is their format, not a lookalike.
    expect(testSchema().$id).toContain('workflow-tester.test.schema.json');
    expect(Array.isArray((testSchema() as { oneOf?: unknown[] }).oneOf)).toBe(true);
  });
});

describe('given keys that need a mock', () => {
  it('are refused at load, naming the key, rather than silently ignored', async () => {
    writeTest(
      'faults.test.yaml',
      `${VALID}given:\n  faults:\n    stripe: { status: 503 }\n`,
    );
    const error = await loadSuites(dir).catch((e: unknown) => e as SuiteError);
    expect(error).toBeInstanceOf(SuiteError);
    expect((error as SuiteError).issues[0]?.message).toMatch(/given\.faults.*not supported/s);
    expect((error as SuiteError).issues[0]?.line).toBeGreaterThan(0);
  });
});
