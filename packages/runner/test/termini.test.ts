import { describe, expect, it } from 'vitest';
import type { EngineResult } from 'payload-contract-engine';
import type { WorkflowJson } from 'payload-contract-generator';
import { terminiOf } from '../src/termini.js';

/** Webhook -> Risky -> {Happy (output 0), Handled (output 1)} */
const workflow: WorkflowJson = {
  nodes: [
    { name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, parameters: {} },
    { name: 'Risky', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: {} },
    { name: 'Happy', type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: {} },
    { name: 'Handled', type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: {} },
  ],
  connections: {
    Webhook: { main: [[{ node: 'Risky', index: 0 }]] },
    Risky: { main: [[{ node: 'Happy', index: 0 }], [{ node: 'Handled', index: 0 }]] },
  },
};

const item = { json: { a: 1 } };
const resultWith = (outputs: Record<string, unknown[][]>): EngineResult =>
  ({
    status: 'pass',
    reachedNodes: Object.keys(outputs),
    outputs,
    failures: [],
    warnings: [],
    boundaries: [],
    substituted: [],
    durationMs: 0,
  }) as unknown as EngineResult;

describe('terminiOf', () => {
  it('finds the node the error branch ended at, and how it was reached', () => {
    const termini = terminiOf(
      workflow,
      resultWith({ Webhook: [[item]], Risky: [[], [item]], Handled: [[item]] }),
    );
    expect(termini).toEqual([{ node: 'Handled', via: { node: 'Risky', output: 1 } }]);
  });

  it('finds the happy terminus when output 0 carried', () => {
    const termini = terminiOf(
      workflow,
      resultWith({ Webhook: [[item]], Risky: [[item], []], Happy: [[item]] }),
    );
    expect(termini).toEqual([{ node: 'Happy', via: { node: 'Risky', output: 0 } }]);
  });

  it('treats a node whose successors all produced nothing as a terminus', () => {
    const termini = terminiOf(workflow, resultWith({ Webhook: [[item]], Risky: [[], []] }));
    expect(termini).toEqual([{ node: 'Risky', via: { node: 'Webhook', output: 0 } }]);
  });

  it('reports the trigger itself when nothing followed it', () => {
    expect(terminiOf(workflow, resultWith({ Webhook: [[item]] }))).toEqual([
      { node: 'Webhook' },
    ]);
  });

  it('reports nothing when no node produced items', () => {
    expect(terminiOf(workflow, resultWith({}))).toEqual([]);
  });
});
