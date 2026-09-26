import { describe, expect, it } from 'vitest';
import type { EngineResult } from 'workflow-tester-engine';
import type { WorkflowJson } from 'workflow-tester-generator';
import { applyClassification, classifyTerminus } from '../src/classify.js';
import type { Outcome } from '../src/oracle.js';

const workflow: WorkflowJson = {
  nodes: [
    { name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, parameters: {} },
    { name: 'Risky', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: {} },
    { name: 'Happy', type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: {} },
    { name: 'Handled', type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: {} },
    { name: 'Reject', type: 'n8n-nodes-base.stopAndError', typeVersion: 1, parameters: {} },
  ],
  connections: {
    Webhook: { main: [[{ node: 'Risky', index: 0 }]] },
    Risky: { main: [[{ node: 'Happy', index: 0 }], [{ node: 'Handled', index: 0 }]] },
  },
};

const base = {
  status: 'pass',
  reachedNodes: [],
  outputs: {},
  failures: [],
  warnings: [],
  boundaries: [],
  substituted: [],
  errorOutputs: [],
  durationMs: 0,
} as unknown as EngineResult;

describe('classifyTerminus', () => {
  it('calls a normal ending happy', () => {
    expect(
      classifyTerminus(workflow, base, { node: 'Happy', via: { node: 'Risky', output: 0 } }, []),
    ).toBe('happy');
  });

  it('calls a terminus reached through an error output known-unhappy', () => {
    const result = { ...base, errorOutputs: ['Risky'] } as EngineResult;
    expect(
      classifyTerminus(workflow, result, { node: 'Handled', via: { node: 'Risky', output: 1 } }, []),
    ).toBe('known-unhappy');
  });

  it('does not call the success branch of an error-output node unhappy', () => {
    const result = { ...base, errorOutputs: ['Risky'] } as EngineResult;
    expect(
      classifyTerminus(workflow, result, { node: 'Happy', via: { node: 'Risky', output: 0 } }, []),
    ).toBe('happy');
  });

  it('calls a Stop and Error terminus known-unhappy', () => {
    expect(classifyTerminus(workflow, base, { node: 'Reject' }, [])).toBe('known-unhappy');
  });

  it('honours a declaration that says this ending is an expected failure', () => {
    expect(
      classifyTerminus(workflow, base, { node: 'Happy' }, [
        { node: 'Happy', expect: 'failure', reason: 'dead-letter path' },
      ]),
    ).toBe('known-unhappy');
  });

  it('lets a declaration overrule an inferred failure', () => {
    expect(
      classifyTerminus(workflow, base, { node: 'Reject' }, [
        { node: 'Reject', expect: 'success' },
      ]),
    ).toBe('happy');
  });

  it('calls an unhandled failure unknown', () => {
    const result = {
      ...base,
      failures: [{ kind: 'expression-error', node: 'Risky', parameter: '', message: 'x', itemIndex: 0 }],
    } as unknown as EngineResult;
    expect(classifyTerminus(workflow, result, { node: 'Risky' }, [])).toBe('unknown');
  });

  it('calls a deliberate stop known-unhappy even by failure kind', () => {
    const result = {
      ...base,
      failures: [{ kind: 'deliberate-stop', node: 'Reject', parameter: '', message: 'no', itemIndex: 0 }],
    } as unknown as EngineResult;
    expect(classifyTerminus(workflow, result, { node: 'Reject' }, [])).toBe('known-unhappy');
  });
});

describe('applyClassification', () => {
  const clean: Outcome = { caseId: 'c1', status: 'pass', mode: 'offline', message: 'ok', assertions: [] };
  const noShapes = { findings: [], unchecked: [] };

  it('keeps a happy ending with an intact contract green', () => {
    const out = applyClassification(clean, [{ terminus: { node: 'Happy' }, kind: 'happy' }], noShapes);
    expect(out.status).toBe('pass');
  });

  it('fails a happy ending whose contract broke', () => {
    const out = applyClassification(clean, [{ terminus: { node: 'Happy' }, kind: 'happy' }], {
      findings: [
        {
          node: 'Happy',
          changes: [{ path: 'sku', kind: 'type-changed', detail: 'was string, now null' }],
        },
      ],
      unchecked: [],
    });
    expect(out.status).toBe('fail');
    expect(out.message).toContain('Happy');
  });

  it('warns when a happy ending has no recorded shape to check', () => {
    const out = applyClassification(clean, [{ terminus: { node: 'Happy' }, kind: 'happy' }], {
      findings: [],
      unchecked: ['Happy'],
    });
    expect(out.status).toBe('warn');
    expect(out.message).toMatch(/unchecked|not recorded|no recorded/i);
  });

  it('warns on a known-unhappy ending', () => {
    const out = applyClassification(
      clean,
      [{ terminus: { node: 'Reject' }, kind: 'known-unhappy' }],
      noShapes,
    );
    expect(out.status).toBe('warn');
  });

  it('fails an unknown ending and says so plainly', () => {
    const out = applyClassification(
      clean,
      [{ terminus: { node: 'Boom' }, kind: 'unknown' }],
      noShapes,
    );
    expect(out.status).toBe('fail');
    expect(out.message).toMatch(/error handling|not account/i);
  });

  it('records every terminus it classified', () => {
    const out = applyClassification(
      clean,
      [
        { terminus: { node: 'Happy' }, kind: 'happy' },
        { terminus: { node: 'Reject' }, kind: 'known-unhappy' },
      ],
      noShapes,
    );
    expect(out.classification).toEqual([
      { node: 'Happy', kind: 'happy' },
      { node: 'Reject', kind: 'known-unhappy' },
    ]);
  });

  it('never downgrades an outcome that already failed', () => {
    const failed: Outcome = { ...clean, status: 'fail' };
    const out = applyClassification(failed, [{ terminus: { node: 'Happy' }, kind: 'happy' }], noShapes);
    expect(out.status).toBe('fail');
  });
});
