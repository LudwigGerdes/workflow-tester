import { describe, expect, it } from 'vitest';
import { walk } from '../src/walk.js';
import { loadNodeTypes } from '../src/node-types.js';
import type { WorkflowJson } from '../src/types.js';

const webhook = {
  id: 'n1',
  name: 'Webhook',
  type: 'n8n-nodes-base.webhook',
  typeVersion: 2,
  position: [0, 0] as [number, number],
  parameters: { path: 'x', httpMethod: 'POST' },
};

/**
 * A Split Out whose required `fieldToSplitOut` resolves to nothing.
 *
 * Split Out is the fixture because its required property carries no
 * `displayOptions` — most of the nodes the engine interprets mark nothing
 * required at all, so a missing-required finding needs a node that declares one
 * unconditionally.
 */
const workflow: WorkflowJson = {
  nodes: [
    webhook,
    {
      id: 'n2',
      name: 'Split',
      type: 'n8n-nodes-base.splitOut',
      typeVersion: 1,
      position: [1, 0],
      parameters: { fieldToSplitOut: '={{ $json.body.missing }}', options: {} },
    },
  ],
  connections: { Webhook: { main: [[{ node: 'Split', type: 'main', index: 0 }]] } },
};

const input = { workflow, trigger: 'Webhook', payload: { body: {} } };

describe('an inexact node-type version', () => {
  it('fails a missing required parameter when the version is exact', async () => {
    const types = await loadNodeTypes();
    expect(types.exact).toBe(true);
    const result = walk(input, types);
    expect(result.failures.some((f) => f.kind === 'required-undefined')).toBe(true);
    expect(result.warnings.some((w) => w.kind === 'required-unverified')).toBe(false);
  });

  it('warns instead when the version is not exact', async () => {
    const types = await loadNodeTypes('99.0.0');
    expect(types.exact).toBe(false);
    const result = walk(input, types);
    expect(result.failures.some((f) => f.kind === 'required-undefined')).toBe(false);
    const warned = result.warnings.find((w) => w.kind === 'required-unverified');
    expect(warned).toBeDefined();
    expect(warned?.node).toBe('Split');
    expect(warned?.message).toMatch(/99\.0\.0/);
  });

  it('leaves an expression failure a failure either way', async () => {
    // Only required-undefined depends on the descriptions being right for the
    // running version. An expression that cannot resolve is wrong whichever
    // n8n version is assumed, so it stays a failure.
    const broken: WorkflowJson = {
      ...workflow,
      nodes: [
        webhook,
        {
          id: 'n2',
          name: 'Split',
          type: 'n8n-nodes-base.splitOut',
          typeVersion: 1,
          position: [1, 0],
          parameters: { fieldToSplitOut: "={{ $('NoSuchNode').item.json.x }}", options: {} },
        },
      ],
    };
    const result = walk({ ...input, workflow: broken }, await loadNodeTypes('99.0.0'));
    expect(result.failures.some((f) => f.kind === 'expression-error')).toBe(true);
  });
});
