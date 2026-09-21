import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/index.js';

let dir: string;
let out: string[];
let err: string[];
const io = () => ({ cwd: dir, out: (s: string) => out.push(s), err: (s: string) => err.push(s) });

const caseDir = () => join(dir, '.workflow-test/cases/invoice/stripe.invoice');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-test-promote-'));
  out = [];
  err = [];
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  mkdirSync(caseDir(), { recursive: true });
  writeFileSync(join(dir, 'workflows/invoice.json'), JSON.stringify({ id: 'w', name: 'w', nodes: [], connections: {} }));
  writeFileSync(
    join(caseDir(), 'abc123.json'),
    JSON.stringify({
      id: 'abc123',
      title: 'optional-absent body.email',
      tags: ['single'],
      payload: { headers: {}, params: {}, query: {}, body: { id: 7 } },
      provenance: { exampleIndex: 0, mutations: [] },
    }),
  );
});

describe('promote', () => {
  it('copies the generated payload into a hand-written test', async () => {
    expect(await run(['promote', 'abc123'], io())).toBe(0);

    const file = join(dir, '.workflow-test/tests/promoted-abc123.test.yaml');
    expect(existsSync(file)).toBe(true);

    const text = readFileSync(file, 'utf8');
    const suite = parse(text) as { workflow: string; cases: Array<{ id: string; title: string; when: { payload: unknown } }> };
    expect(suite.cases[0]?.id).toBe('abc123');
    expect(suite.cases[0]?.title).toBe('optional-absent body.email');
    // the payload is carried verbatim — that is what makes the promotion faithful
    expect(suite.cases[0]?.when.payload).toEqual({ headers: {}, params: {}, query: {}, body: { id: 7 } });
    // and it points back at the workflow from where it now lives
    expect(suite.workflow).toMatch(/workflows\/invoice\.json$/);
  });

  it('leaves a `then:` skeleton to fill in', async () => {
    await run(['promote', 'abc123'], io());
    const text = readFileSync(join(dir, '.workflow-test/tests/promoted-abc123.test.yaml'), 'utf8');
    expect(text).toMatch(/# +then:/);
    expect(text).toContain('execution.status: success');
  });

  it('keeps the original from being retired', async () => {
    await run(['promote', 'abc123'], io());
    expect(readFileSync(join(caseDir(), '.keep'), 'utf8').trim()).toBe('abc123');
  });

  it('accepts a name', async () => {
    expect(await run(['promote', 'abc123', '--name', 'missing-email'], io())).toBe(0);
    expect(existsSync(join(dir, '.workflow-test/tests/missing-email.test.yaml'))).toBe(true);
  });

  it('refuses to overwrite an existing test', async () => {
    await run(['promote', 'abc123'], io());
    out = [];
    expect(await run(['promote', 'abc123'], io())).toBe(2);
    expect(err.join('\n')).toMatch(/already exists/);
  });

  it('reports an unknown case id', async () => {
    expect(await run(['promote', 'nope'], io())).toBe(2);
    expect(err.join('\n')).toMatch(/nope/);
  });

  it('needs a case id', async () => {
    expect(await run(['promote'], io())).toBe(2);
  });
});
