import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { INodeExecutionData } from 'n8n-workflow';
import { loadNodeTypes, type NodeTypeSource } from '../src/node-types.js';
import { semanticsFor } from '../src/semantics/index.js';
import { walk } from '../src/walk.js';
import type { WorkflowJson } from '../src/types.js';

/**
 * Semantic execution fixtures: the engine's node semantics checked against what n8n itself
 * actually produced.
 *
 * These fixtures are real execution exports — the body of
 * `GET /api/v1/executions/:id?includeData=true` from n8n 2.10.0, kept verbatim.
 * They are the only evidence that the reimplemented semantics agree
 * with n8n rather than merely with their author, which is all a hand-written
 * expectation can show. See `docs/maintainers/capturing-fixtures.md` for how to make more.
 *
 * On a disagreement the export wins.
 *
 * Two incidental artefacts are normalised before comparison, and only these:
 *
 * - an **empty `binary: {}`**, which n8n attaches on some paths and which
 *   carries no data;
 * - **duplicate entries within a `pairedItem` array**. n8n's combine-by-position
 *   records the same source item more than once (three entries for two inputs);
 *   the set of sources is what a paired-item lookup resolves through, so the
 *   repetition changes nothing an expression can observe.
 *
 * Both are narrow and named on purpose. Everything else — every `json` value,
 * every output index, every paired-item reference — is compared exactly, because
 * a normalisation that grew to fit whatever failed would defeat the point of
 * having execution fixtures at all.
 */

interface ExecutionExport {
  id: number;
  status: string;
  mode: string;
  workflowData: WorkflowJson & { nodes: Array<{ name: string; type: string; typeVersion: number }> };
  data: {
    resultData: {
      runData: Record<string, Array<{ data?: { main?: Array<INodeExecutionData[] | null> } }>>;
    };
  };
}

const dir = fileURLToPath(new URL('./fixtures/executions/', import.meta.url));
const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();

const load = (name: string): ExecutionExport =>
  JSON.parse(readFileSync(`${dir}${name}`, 'utf8')) as ExecutionExport;

/** Strip the two documented artefacts, and nothing else. */
function normalise(items: INodeExecutionData[]): INodeExecutionData[] {
  return items.map((item) => {
    const copy: INodeExecutionData = { ...item };
    if (copy.binary !== undefined && Object.keys(copy.binary).length === 0) delete copy.binary;
    if (Array.isArray(copy.pairedItem)) {
      const seen = new Set<string>();
      copy.pairedItem = copy.pairedItem.filter((entry) => {
        const key = JSON.stringify(entry);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    return copy;
  });
}

/** The node the run started from: the one with no inbound main connection. */
function triggerOf(workflow: ExecutionExport['workflowData']): string {
  const targets = new Set(
    Object.values(workflow.connections ?? {}).flatMap((c) =>
      (c.main ?? []).flat().map((edge) => edge?.node),
    ),
  );
  const start = workflow.nodes.find((node) => !targets.has(node.name));
  return start?.name ?? workflow.nodes[0]?.name ?? '';
}

describe('semantic execution fixtures from real n8n executions', () => {
  let types: NodeTypeSource;
  beforeAll(async () => {
    types = await loadNodeTypes();
  });

  it('has at least one captured execution to check against', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  describe.each(files)('%s', (file) => {
    it('is a real export, not a hand-written one', () => {
      const exported = load(file);
      // `error-run.json` is deliberately a failed run — a fixture set
      // that only accepted clean runs would never cover the failure path.
      expect(['success', 'error']).toContain(exported.status);
      expect(exported.workflowData).toBeDefined();
      expect(Object.keys(exported.data.resultData.runData).length).toBeGreaterThan(1);
    });

    it('reproduces every interpreted node, pairedItem included', () => {
      const exported = load(file);
      const runData = exported.data.resultData.runData;
      const trigger = triggerOf(exported.workflowData);

      // Seed from what the trigger actually emitted in the real run.
      const seeded = runData[trigger]?.[0]?.data?.main?.[0] ?? [];
      const result = walk(
        { workflow: exported.workflowData, trigger, payload: seeded[0]?.json ?? {} },
        types,
      );

      const checked: string[] = [];
      const skipped: string[] = [];
      const divergences: string[] = [];

      for (const node of exported.workflowData.nodes) {
        if (node.name === trigger) continue;
        if (semanticsFor(node.type, node.typeVersion) === undefined) continue;

        const runs = runData[node.name] ?? [];

        // A node inside a loop runs several times. The engine models a single
        // pass, so it cannot reproduce that — and silently comparing run 0
        // would claim coverage it does not have. The multi-run fixture
        // exists precisely to catch a consumer that reads only `[0]`.
        if (runs.length > 1) {
          skipped.push(`${node.name}: ran ${runs.length} times; the engine models a single pass`);
          continue;
        }
        // A node the run never reached (an error export stops early) has
        // nothing to compare against.
        if (runs.length === 0 || runs[0]?.data?.main === undefined) {
          skipped.push(`${node.name}: no output recorded in this run`);
          continue;
        }

        const expected = runs[0]?.data?.main ?? [];
        const actual = result.outputs[node.name];
        if (actual === undefined) {
          skipped.push(`${node.name}: the engine stopped before it (boundary upstream)`);
          continue;
        }

        // Compare output by output, so a mismatch names the node and branch.
        const expectedTrimmed = expected.map((items) => normalise(items ?? []));
        try {
          expect(actual.slice(0, expectedTrimmed.length).map(normalise)).toEqual(expectedTrimmed);
          checked.push(node.name);
        } catch {
          divergences.push(
            `${node.name} (${node.type})\n` +
              `      n8n: ${JSON.stringify(expectedTrimmed)}\n` +
              `      workflow-test: ${JSON.stringify(actual.slice(0, expectedTrimmed.length))}`,
          );
        }
      }

      if (divergences.length > 0) {
        throw new Error(
          `${divergences.length} node(s) diverge from the real execution:\n  ${divergences.join('\n  ')}`,
        );
      }

      // A workflow of nothing but boundaries — the error export is a Code
      // node — has nothing to compare. That is a legitimate fixture: it proves
      // the engine stops cleanly rather than that a semantic is right.
      if (checked.length === 0 && skipped.length === 0) {
        skipped.push('no expression-pure nodes in this workflow; nothing to compare');
      }

      // Say what was not covered, so a node quietly dropping out of the execution fixtures
      // is visible rather than passing by omission.
      // eslint-disable-next-line no-console
      if (skipped.length > 0) console.log(`  ${file}: skipped\n    ${skipped.join('\n    ')}`);

      // Whatever the workflow held, the walk must have run and reached its trigger.
      expect(result.reachedNodes).toContain(trigger);
    });
  });
});
