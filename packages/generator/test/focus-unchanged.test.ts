import { describe, expect, it } from 'vitest';
import { extractFocusPaths, chainsIn, type WorkflowJson } from '../src/focus.js';

const workflow: WorkflowJson = {
  nodes: [
    { name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, parameters: {} },
    {
      name: 'Edit',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      parameters: {
        assignments: {
          assignments: [
            { name: 'who', type: 'string', value: '={{ $json.body.user.name }}' },
            { name: 'first', type: 'string', value: '={{ $json.body.items[7].sku }}' },
          ],
        },
      },
    },
  ],
  connections: { Webhook: { main: [[{ node: 'Edit', index: 0 }]] } },
};

describe('extractFocusPaths', () => {
  it('still collapses indices to the array, as case ids depend on', () => {
    const paths = extractFocusPaths(workflow, 'Webhook').map((p) => p.path).sort();
    expect(paths).toEqual(['body.items[].sku', 'body.user.name']);
  });
});

describe('chainsIn', () => {
  it('reports every chain with its literal indices intact', () => {
    const chains = chainsIn(workflow).filter((c) => c.node === 'Edit');
    const rendered = chains.map((c) => c.chain).map((chain) =>
      chain.map((s) => (s.kind === 'index' ? `[${s.index}]` : s.name)).join('.'),
    );
    expect(rendered).toContain('body.items.[7].sku');
    expect(rendered).toContain('body.user.name');
  });

  it('names the node and parameter each chain came from', () => {
    const chain = chainsIn(workflow).find((c) =>
      c.chain.some((s) => s.kind === 'index' && s.index === 7),
    );
    expect(chain?.node).toBe('Edit');
    expect(chain?.parameter).toContain('assignments');
    expect(chain?.root).toEqual({ kind: 'json' });
  });
});
