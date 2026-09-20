import { describe, expect, it } from 'vitest';
import type { EngineResult } from 'payload-contract-engine';
import type { CaptureRecord } from 'payload-contract-contracts';
import { checkTerminalShape } from '../src/terminal-shape.js';

const resultWith = (outputs: Record<string, unknown[][]>): EngineResult =>
  ({
    status: 'pass',
    reachedNodes: Object.keys(outputs),
    outputs,
    failures: [],
    warnings: [],
    boundaries: [],
    substituted: [],
    durationMs: 0,
  }) as unknown as EngineResult;

const capture: CaptureRecord = {
  capturedAt: '2026-09-07T00:00:00.000Z',
  nodes: {
    Format: {
      shape: {
        type: 'object',
        fields: { customerName: { type: 'string' }, firstSku: { type: 'string' } },
      },
      items: 1,
    },
  },
};

describe('checkTerminalShape', () => {
  it('says nothing when the terminus produces the shape it recorded', () => {
    const report = checkTerminalShape(
      resultWith({ Format: [[{ json: { customerName: 'ada', firstSku: 'A1' } }]] }),
      capture,
      [{ node: 'Format' }],
    );
    expect(report.findings).toEqual([]);
    expect(report.unchecked).toEqual([]);
  });

  it('reports a field whose type changed', () => {
    const report = checkTerminalShape(
      resultWith({ Format: [[{ json: { customerName: 'grace', firstSku: null } }]] }),
      capture,
      [{ node: 'Format' }],
    );
    expect(report.findings).toHaveLength(1);
    const [finding] = report.findings;
    expect(finding?.node).toBe('Format');
    expect(finding?.changes.map((c) => `${c.kind} ${c.path}`)).toContain('type-changed firstSku');
  });

  it('reports a field that is no longer produced', () => {
    const report = checkTerminalShape(
      resultWith({ Format: [[{ json: { customerName: 'ada' } }]] }),
      capture,
      [{ node: 'Format' }],
    );
    expect(report.findings[0]?.changes.map((c) => c.kind)).toContain('removed');
  });

  it('names a terminus the capture never recorded rather than passing it', () => {
    const report = checkTerminalShape(
      resultWith({ Other: [[{ json: { x: 1 } }]] }),
      capture,
      [{ node: 'Other' }],
    );
    expect(report.findings).toEqual([]);
    expect(report.unchecked).toEqual(['Other']);
  });

  it('reports nothing at all when there is no capture', () => {
    // Not "unchecked": with no capture there is nothing to be unchecked
    // against, and a hand-written case carries its own expectations. Warning
    // here would turn every existing suite yellow.
    const report = checkTerminalShape(
      resultWith({ Format: [[{ json: { customerName: 'ada' } }]] }),
      undefined,
      [{ node: 'Format' }],
    );
    expect(report.findings).toEqual([]);
    expect(report.unchecked).toEqual([]);
  });
});
