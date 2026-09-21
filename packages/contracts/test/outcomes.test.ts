import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { outcomesFor } from '../src/capture.js';

const workflowIn = (dir: string, sidecar: string): string => {
  writeFileSync(join(dir, 'wf.json'), '{}');
  writeFileSync(join(dir, 'wf.contract.yaml'), sidecar);
  return join(dir, 'wf.json');
};

describe('outcomesFor', () => {
  it('reads declarations from the sidecar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-test-out-'));
    const file = workflowIn(
      dir,
      `version: 1
outcomes:
  - node: Notify Ops
    expect: failure
    reason: dead-letter path, deliberate
`,
    );
    expect(outcomesFor(file)).toEqual([
      { node: 'Notify Ops', expect: 'failure', reason: 'dead-letter path, deliberate' },
    ]);
  });

  it('returns nothing when the sidecar declares none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-test-out-'));
    expect(outcomesFor(workflowIn(dir, 'version: 1\n'))).toEqual([]);
  });

  it('returns nothing when there is no sidecar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-test-out-'));
    writeFileSync(join(dir, 'wf.json'), '{}');
    expect(outcomesFor(join(dir, 'wf.json'))).toEqual([]);
  });

  it('ignores an entry with an unknown expectation rather than guessing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-test-out-'));
    const file = workflowIn(dir, 'version: 1\noutcomes:\n  - node: X\n    expect: maybe\n');
    expect(outcomesFor(file)).toEqual([]);
  });
});
