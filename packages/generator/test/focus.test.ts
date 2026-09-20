import { describe, expect, it } from 'vitest';
import { extractFocusPaths } from '../src/focus.js';
import type { WorkflowJson } from '../src/focus.js';

const webhook = {
  parameters: { httpMethod: 'POST', path: 'x', options: {} },
  id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0] as [number, number],
};

const set = (
  name: string,
  assignments: Array<{ name: string; value: string }>,
  includeOtherFields = false,
) => ({
  parameters: {
    mode: 'manual',
    includeOtherFields,
    assignments: {
      assignments: assignments.map((a, i) => ({ id: `a${i}`, name: a.name, value: a.value, type: 'string' })),
    },
    options: {},
  },
  id: name, name, type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [0, 0] as [number, number],
});

const chain = (...nodes: Array<{ name: string }>): WorkflowJson => ({
  id: 'w',
  name: 'w',
  nodes: nodes as WorkflowJson['nodes'],
  connections: Object.fromEntries(
    nodes.slice(0, -1).map((n, i) => [
      n.name,
      { main: [[{ node: nodes[i + 1]?.name ?? '', type: 'main', index: 0 }]] },
    ]),
  ),
});

const paths = (wf: WorkflowJson): string[] =>
  extractFocusPaths(wf, 'Webhook').map((f) => f.path).sort();

describe('extractFocusPaths', () => {
  it('finds a path read directly off the trigger', () => {
    expect(paths(chain(webhook, set('A', [{ name: 'email', value: '={{ $json.body.email }}' }])))).toEqual([
      'body.email',
    ]);
  });

  it('attributes each path to the node and parameter that reads it', () => {
    const found = extractFocusPaths(
      chain(webhook, set('A', [{ name: 'email', value: '={{ $json.body.email }}' }])),
      'Webhook',
    );
    expect(found[0]?.sources[0]).toMatchObject({ node: 'A', parameter: expect.stringContaining('assignments') });
    expect(found[0]?.sources[0]?.expression).toContain('$json.body.email');
  });

  it('resolves a trigger reference from any depth', () => {
    const wf = chain(
      webhook,
      set('A', [{ name: 'x', value: 'literal' }]),
      set('B', [{ name: 'y', value: 'literal' }]),
      set('C', [{ name: 'z', value: "={{ $('Webhook').item.json.body.record.name }}" }]),
    );
    expect(paths(wf)).toEqual(['body.record.name']);
  });

  it('follows $json through a Set that passes other fields through', () => {
    const wf = chain(
      webhook,
      set('A', [{ name: 'other', value: 'literal' }], true),
      set('B', [{ name: 'z', value: '={{ $json.body.email }}' }]),
    );
    expect(paths(wf)).toContain('body.email');
  });

  it('follows a field a Set renamed', () => {
    const wf = chain(
      webhook,
      set('A', [{ name: 'email', value: '={{ $json.body.email }}' }]),
      set('B', [{ name: 'z', value: '={{ $json.email }}' }]),
    );
    // both the direct read and the downstream read of the renamed key
    expect(paths(wf)).toEqual(['body.email']);
  });

  it('drops a downstream $json path with no traceable lineage', () => {
    const wf = chain(
      webhook,
      set('A', [{ name: 'email', value: 'literal' }]),
      set('B', [{ name: 'z', value: '={{ $json.somethingElse }}' }]),
    );
    expect(paths(wf)).toEqual([]);
  });

  it('stops at a boundary node: lineage past it is unknown', () => {
    const http = { parameters: {}, id: 'h', name: 'Call', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [0, 0] as [number, number] };
    const wf = chain(webhook, http, set('B', [{ name: 'z', value: '={{ $json.body.email }}' }]));
    expect(paths(wf)).toEqual([]);
  });

  it('reads bracket and optional-chained access', () => {
    const wf = chain(
      webhook,
      set('A', [
        { name: 'a', value: '={{ $json.body["record"].name }}' },
        { name: 'b', value: '={{ $json.body?.other?.name }}' },
      ]),
    );
    expect(paths(wf)).toEqual(['body.other.name', 'body.record.name']);
  });

  it('normalises array indexes so they line up with the schema', () => {
    const wf = chain(webhook, set('A', [{ name: 'a', value: '={{ $json.body.lines[0].amount }}' }]));
    expect(paths(wf)).toEqual(['body.lines[].amount']);
  });

  it('drops a dynamically-keyed path but keeps what the key itself reads', () => {
    const wf = chain(
      webhook,
      set('A', [
        { name: 'a', value: '={{ $json.body[$json.which].name }}' },
        { name: 'b', value: '={{ $json.body.fine }}' },
      ]),
    );
    // `body[<computed>].name` cannot be named, so it is dropped — but the
    // workflow really does read `$json.which`, and varying that can change which
    // branch of the payload is read, so it belongs in the focus set.
    expect(paths(wf)).toEqual(['body.fine', 'which']);
  });

  it('reads several expressions in one parameter', () => {
    const wf = chain(
      webhook,
      set('A', [{ name: 'a', value: '={{ $json.body.first }} and {{ $json.body.second }}' }]),
    );
    expect(paths(wf)).toEqual(['body.first', 'body.second']);
  });

  it('ignores $ helpers that are not payload data', () => {
    const wf = chain(
      webhook,
      set('A', [
        { name: 'a', value: '={{ $now.toISO() }}' },
        { name: 'b', value: "={{ $('Webhook').params.path }}" },
        { name: 'c', value: '={{ $json.body.real }}' },
      ]),
    );
    expect(paths(wf)).toEqual(['body.real']);
  });

  it('deduplicates a path read from several places, keeping every source', () => {
    const wf = chain(
      webhook,
      set('A', [{ name: 'a', value: '={{ $json.body.email }}' }]),
      set('B', [{ name: 'b', value: "={{ $('Webhook').item.json.body.email }}" }]),
    );
    const found = extractFocusPaths(wf, 'Webhook');
    expect(found).toHaveLength(1);
    expect(found[0]?.sources.map((s) => s.node).sort()).toEqual(['A', 'B']);
  });

  it('reads expressions in nested parameter structures, such as IF conditions', () => {
    const ifNode = {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            { id: 'c', leftValue: '={{ $json.body.amount }}', rightValue: 100, operator: { type: 'number', operation: 'gt' } },
          ],
          combinator: 'and',
        },
        options: {},
      },
      id: 'i', name: 'Big?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [0, 0] as [number, number],
    };
    expect(paths(chain(webhook, ifNode))).toEqual(['body.amount']);
  });
});

const code = (name: string) => ({
  parameters: { mode: 'runOnceForAllItems', jsCode: 'return $input.all();' },
  id: name, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0] as [number, number],
});

describe('lineage through a Code node', () => {
  const wf = (read: string) =>
    chain(webhook, code('Score'), set('A', [{ name: 'x', value: `={{ $json.body.${read} }}` }]));

  it('stops at a Code node when nothing was observed', () => {
    // Arbitrary JavaScript: with no observation there is nothing to justify a
    // claim about what came out, so the safe answer stands.
    expect(extractFocusPaths(wf('email'), 'Webhook').map((f) => f.path)).not.toContain('body.email');
  });

  it('carries on for a field observed to survive the Code node', () => {
    const focus = extractFocusPaths(wf('email'), 'Webhook', {
      survives: (node, path) => node === 'Score' && path === 'body.email',
    });
    expect(focus.map((f) => f.path)).toContain('body.email');
  });

  it('does not carry a field the Code node dropped', () => {
    const focus = extractFocusPaths(wf('gone'), 'Webhook', { survives: () => false });
    expect(focus.map((f) => f.path)).not.toContain('body.gone');
  });
});
