import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readSnapshotFile, snapshotStandIns } from '../src/snapshot.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-tester-snapshot-'));
  mkdirSync(join(dir, 'snap'));
  writeFileSync(join(dir, 'snap/4123.json'), JSON.stringify({ packs: [] }));
  writeFileSync(
    join(dir, 'snap/4123.export.json'),
    JSON.stringify({
      data: {
        resultData: {
          runData: {
            Fetch: [
              { data: { main: [[{ json: { id: 1 } }]] } },
              { data: { main: [[{ json: { id: 2 } }]] } },
            ],
            Notify: [{ data: { main: [[{ json: { ok: true } }]] } }],
          },
        },
      },
    }),
  );
});

describe('snapshot stand-ins', () => {
  it('stands in with run 0 of each node, from the export beside the snapshot', () => {
    expect(snapshotStandIns(join(dir, 'x.test.yaml'), 'snap/4123.json')).toEqual({
      Fetch: [{ json: { id: 1 } }],
      Notify: [{ json: { ok: true } }],
    });
  });

  it('names the missing export', () => {
    writeFileSync(join(dir, 'snap/9.json'), '{}');
    expect(() => snapshotStandIns(join(dir, 'x.test.yaml'), 'snap/9.json')).toThrow('snapshot export not found: snap/9.export.json');
  });

  it('reads the snapshot file relative to the test file, and names a missing one', () => {
    expect(readSnapshotFile(join(dir, 'x.test.yaml'), 'snap/4123.json')).toEqual({ packs: [] });
    expect(() => readSnapshotFile(join(dir, 'x.test.yaml'), 'snap/10.json')).toThrow('snapshot not found: snap/10.json');
  });
});

describe('snapshot errors name the file', () => {
  it('offline, a missing snapshot file fails even when an export is there', () => {
    writeFileSync(join(dir, 'snap/55.export.json'), JSON.stringify({ data: { resultData: { runData: {} } } }));
    expect(() => snapshotStandIns(join(dir, 'x.test.yaml'), 'snap/55.json')).toThrow('snapshot not found: snap/55.json');
  });

  it('an unparseable snapshot or export names its path', () => {
    writeFileSync(join(dir, 'snap/66.json'), '{ not json');
    writeFileSync(join(dir, 'snap/77.json'), '{}');
    writeFileSync(join(dir, 'snap/77.export.json'), '{ not json');
    expect(() => readSnapshotFile(join(dir, 'x.test.yaml'), 'snap/66.json')).toThrow('snapshot is not valid JSON: snap/66.json');
    expect(() => snapshotStandIns(join(dir, 'x.test.yaml'), 'snap/77.json')).toThrow('snapshot export is not valid JSON: snap/77.export.json');
  });
});
