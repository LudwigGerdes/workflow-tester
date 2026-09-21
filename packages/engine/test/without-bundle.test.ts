import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadNodeTypes } from '../src/node-types.js';
import { walk } from '../src/walk.js';
import type { WorkflowJson } from '../src/types.js';

const fixture = (name: string): WorkflowJson =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/workflows/${name}.json`, import.meta.url)), 'utf8'),
  ) as WorkflowJson;

const envelope = (body: unknown) => ({ headers: {}, params: {}, query: {}, body });

/**
 * The bundled node descriptions are n8n's work and may be absent from a
 * checkout or a build. The tool has to keep working without them: expressions
 * and the pure-node semantics consult no description, so only the
 * required-parameter check is lost — and the run says so.
 */
describe('running without any node descriptions', () => {
  const emptyFloor = mkdtempSync(join(tmpdir(), 'workflow-tester-no-bundle-'));
  const emptyCache = mkdtempSync(join(tmpdir(), 'workflow-tester-no-cache-'));

  it('loads an empty source with a warning instead of throwing', async () => {
    const source = await loadNodeTypes(undefined, { floor: emptyFloor, root: emptyCache });
    expect(source.hasDescriptions).toBe(false);
    expect(source.exact).toBe(false);
    expect(source.describe('n8n-nodes-base.set')).toBeUndefined();
    expect(source.sourceNote).toMatch(/no node descriptions found/);
    expect(source.sourceNote).toMatch(/required-parameter checks are skipped/);
  });

  it('still walks a pure workflow on the built-in semantics', async () => {
    const source = await loadNodeTypes(undefined, { floor: emptyFloor, root: emptyCache });
    const result = walk(
      { workflow: fixture('linear'), trigger: 'Webhook', payload: envelope({ email: 'a@x.io' }) },
      source,
    );
    expect(result.status).toBe('pass');
    expect(result.reachedNodes).toEqual(['Webhook', 'Extract', 'Has Email?', 'Yes']);
    expect(result.outputs.Extract?.[0]?.[0]?.json).toEqual({ email: 'a@x.io' });
    expect(result.failures).toEqual([]);
  });

  it('keeps reporting a non-pure node as a boundary', async () => {
    const source = await loadNodeTypes(undefined, { floor: emptyFloor, root: emptyCache });
    const result = walk(
      { workflow: fixture('boundary'), trigger: 'Webhook', payload: envelope({ email: 'a@x.io' }) },
      source,
    );
    expect(result.status).toBe('boundary');
    expect(result.boundaries[0]?.type).toBe('n8n-nodes-base.httpRequest');
  });
});
