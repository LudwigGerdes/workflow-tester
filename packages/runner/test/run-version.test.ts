import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTier1 } from '../src/run.js';

/** A repo with one workflow and one case. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'payload-contract-run-'));
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  mkdirSync(join(dir, '.payload-contract', 'tests'), { recursive: true });
  writeFileSync(
    join(dir, 'workflows', 'w.json'),
    JSON.stringify({
      nodes: [
        {
          id: 'n1',
          name: 'Webhook',
          type: 'n8n-nodes-base.webhook',
          typeVersion: 2,
          position: [0, 0],
          parameters: { path: 'x', httpMethod: 'POST' },
        },
      ],
      connections: {},
    }),
  );
  writeFileSync(
    join(dir, '.payload-contract', 'tests', 'a.test.yaml'),
    'workflow: ../../workflows/w.json\ncases:\n  - id: one\n    when: {}\n',
  );
  return dir;
}

describe('the version a run uses', () => {
  it('reports the bundled floor when nothing is pinned', async () => {
    const report = await runTier1({ dir: repo(), sandbox: false });
    expect(report.nodeTypes?.exact).toBe(true);
    expect(report.nodeTypes?.version).toBe('2.10.0');
  });

  it('honours a pinned version, and says the match is not exact', async () => {
    // Nothing is extracted for 9.9.9, so the floor stands in — and the report
    // has to say so, or the degraded finding is invisible.
    const report = await runTier1({ dir: repo(), sandbox: false, n8nVersion: '9.9.9' });
    expect(report.nodeTypes?.exact).toBe(false);
    expect(report.nodeTypes?.note).toMatch(/9\.9\.9/);
  });
});
