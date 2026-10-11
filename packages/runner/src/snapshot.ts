import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { IDataObject, INodeExecutionData } from 'n8n-workflow';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** The snapshot file a case names, relative to its test file, parsed. */
export function readSnapshotFile(testFile: string, snapshot: string): unknown {
  const file = resolve(dirname(testFile), snapshot);
  if (!existsSync(file)) throw new Error(`snapshot not found: ${snapshot}`);
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

/** Run 0's first main output of one node, as items. */
function firstRun(runs: unknown): INodeExecutionData[] | undefined {
  if (!Array.isArray(runs)) return undefined;
  const run: unknown = runs[0];
  const data = isRecord(run) ? run['data'] : undefined;
  const main = isRecord(data) ? data['main'] : undefined;
  const items: unknown = Array.isArray(main) ? main[0] : undefined;
  if (!Array.isArray(items)) return undefined;
  return items.map((item: unknown) => ({ json: (isRecord(item) && isRecord(item['json']) ? item['json'] : {}) as IDataObject }));
}

/**
 * Each node's first-run output from the execution export integration-mock
 * writes beside a snapshot (`<execution id>.export.json`). Run 0 only: a node
 * that ran in a loop stands in with its first pass.
 */
export function snapshotStandIns(testFile: string, snapshot: string): Record<string, INodeExecutionData[]> {
  const exportPath = snapshot.replace(/\.json$/, '.export.json');
  const file = resolve(dirname(testFile), exportPath);
  if (!existsSync(file)) throw new Error(`snapshot export not found: ${exportPath}`);
  const doc: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const data = isRecord(doc) ? doc['data'] : undefined;
  const resultData = isRecord(data) ? data['resultData'] : undefined;
  const runData = isRecord(resultData) ? resultData['runData'] : undefined;
  const out: Record<string, INodeExecutionData[]> = {};
  for (const [node, runs] of Object.entries(isRecord(runData) ? runData : {})) {
    const items = firstRun(runs);
    if (items !== undefined) out[node] = items;
  }
  return out;
}
