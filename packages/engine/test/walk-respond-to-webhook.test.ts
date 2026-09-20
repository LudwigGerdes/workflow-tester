import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { walk } from '../src/walk.js';
import { loadNodeTypes, type NodeTypeSource } from '../src/node-types.js';
import type { WorkflowJson } from '../src/types.js';

const fixture = (): WorkflowJson =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/workflows/respond.json', import.meta.url)), 'utf8'),
  ) as WorkflowJson;

const envelope = (body: unknown) => ({ headers: {}, params: {}, query: {}, body });

/**
 * The flagship shape of a webhook workflow ends in Respond to Webhook. That
 * node used to be a boundary, so every such workflow reported "needs a real
 * execution" even when every expression upstream had resolved — and the
 * `execution.status: success` expectation `init` scaffolds could never hold.
 */
describe('walk through Respond to Webhook', () => {
  let types: NodeTypeSource;
  beforeAll(async () => {
    types = await loadNodeTypes();
  });

  it('runs to the end of a webhook workflow that responds', () => {
    const result = walk(
      { workflow: fixture(), trigger: 'Webhook', payload: envelope({ email: 'a@x.io' }) },
      types,
    );
    expect(result.status).toBe('pass');
    expect(result.boundaries).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.reachedNodes).toEqual(['Webhook', 'Normalize', 'Is Pro?', 'Respond Free']);
    expect(result.outputs['Respond Free']?.[0]?.[0]?.json).toEqual({ email: 'a@x.io', plan: 'free' });
  });

  it('evaluates the response body with n8n\'s own engine', () => {
    const result = walk(
      { workflow: fixture(), trigger: 'Webhook', payload: envelope({ email: 'a@x.io', plan: 'pro' }) },
      types,
    );
    expect(result.status).toBe('pass');
    expect(result.reachedNodes).toEqual(['Webhook', 'Normalize', 'Is Pro?', 'Respond Pro']);
    expect(result.outputs['Respond Pro']?.[0]).toHaveLength(1);
  });

  it('warns when the response body resolves to nothing, the way Set does for an assignment', () => {
    // n8n's evaluator swallows the throw to `undefined` and the node sends an
    // empty body — no error anywhere. The warning is the only trace.
    const workflow = fixture();
    const respond = workflow.nodes.find((node) => node.name === 'Respond Pro');
    if (respond === undefined) throw new Error('fixture lost its Respond Pro node');
    respond.parameters.responseBody = '={{ $json.missing.deeper }}';
    const result = walk(
      { workflow, trigger: 'Webhook', payload: envelope({ email: 'a@x.io', plan: 'pro' }) },
      types,
    );
    expect(result.status).toBe('pass');
    expect(result.failures).toEqual([]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ kind: 'optional-undefined', node: 'Respond Pro', parameter: 'responseBody' }),
    );
  });
});
