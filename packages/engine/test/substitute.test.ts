import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { walk } from '../src/walk.js';
import { loadNodeTypes, type NodeTypeSource } from '../src/node-types.js';
import type { WorkflowJson } from '../src/types.js';

const fixture = (name: string): WorkflowJson =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/workflows/${name}.json`, import.meta.url)), 'utf8'),
  ) as WorkflowJson;

const envelope = (body: unknown) => ({ headers: {}, params: {}, query: {}, body });

describe('substituting an unrunnable node', () => {
  let types: NodeTypeSource;
  beforeAll(async () => {
    types = await loadNodeTypes();
  });

  it('stops at the boundary with no stand-in', () => {
    const result = walk(
      { workflow: fixture('boundary'), trigger: 'Webhook', payload: envelope({ email: 'a@x.io' }) },
      types,
    );
    expect(result.status).toBe('boundary');
    expect(result.reachedNodes).not.toContain('After');
    expect(result.substituted).toEqual([]);
  });

  it('carries on past it when a stand-in is supplied', () => {
    const result = walk(
      {
        workflow: fixture('boundary'),
        trigger: 'Webhook',
        payload: envelope({ email: 'a@x.io' }),
        substitutes: { 'Call API': [{ json: { status: 'ok' } }] },
      },
      types,
    );
    // The node after the boundary is now verified, which is the whole point.
    expect(result.reachedNodes).toContain('After');
    expect(result.substituted).toEqual(['Call API']);
    expect(result.status).toBe('pass');
  });

  it('feeds the stand-in downstream, so later expressions read it', () => {
    const result = walk(
      {
        workflow: fixture('boundary'),
        trigger: 'Webhook',
        payload: envelope({ email: 'a@x.io' }),
        substitutes: { 'Call API': [{ json: { status: 'ok' } }] },
      },
      types,
    );
    expect(result.outputs['Call API']?.[0]?.[0]?.json).toEqual({ status: 'ok' });
    expect(result.outputs['After']).toBeDefined();
  });

  it('substitutes a Code node that reaches outside itself', () => {
    const result = walk(
      {
        workflow: fixture('code-impure'),
        trigger: 'Webhook',
        payload: envelope({ a: 1 }),
        substitutes: { 'Fetch In Code': [{ json: { fetched: true } }] },
      },
      types,
    );
    expect(result.substituted).toEqual(['Fetch In Code']);
    expect(result.reachedNodes).toContain('After');
    expect(result.boundaries).toEqual([]);
  });

  it('names substituted nodes separately from computed ones', () => {
    const result = walk(
      {
        workflow: fixture('boundary'),
        trigger: 'Webhook',
        payload: envelope({ email: 'a@x.io' }),
        substitutes: { 'Call API': [{ json: { status: 'ok' } }] },
      },
      types,
    );
    // Verified against a stand-in is a weaker claim than verified, and the
    // result has to keep them apart.
    expect(result.substituted).not.toContain('Prepare');
    expect(result.reachedNodes).toContain('Prepare');
  });
});
