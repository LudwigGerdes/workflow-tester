import { describe, expect, it } from 'vitest';
import type { CaptureRecord } from 'workflow-test-contracts';
import { caseFromCapture } from '../src/capture-case.js';

const capture: CaptureRecord = {
  capturedAt: '2026-09-07T00:00:00.000Z',
  nodes: {
    Webhook: {
      shape: {
        type: 'object',
        fields: {
          body: {
            type: 'object',
            fields: { user: { type: 'object', fields: { name: { type: 'string' } } } },
          },
        },
      },
      items: 1,
    },
    Format: { shape: { type: 'object', fields: { name: { type: 'string' } } }, items: 1 },
  },
};

describe('caseFromCapture', () => {
  it('builds a payload shaped like what the trigger actually received', () => {
    const derived = caseFromCapture(capture, 'Webhook');
    expect(derived).toBeDefined();
    const payload = derived?.payload as { body?: { user?: { name?: unknown } } };
    expect(typeof payload.body?.user?.name).toBe('string');
  });

  it('gives the case a stable id, so reports do not churn', () => {
    expect(caseFromCapture(capture, 'Webhook')?.id).toBe(
      caseFromCapture(capture, 'Webhook')?.id,
    );
  });

  it('names itself so a reader knows where the case came from', () => {
    expect(caseFromCapture(capture, 'Webhook')?.title).toMatch(/capture/i);
  });

  it('declines when the capture never recorded the trigger', () => {
    expect(caseFromCapture(capture, 'Nope')).toBeUndefined();
  });

  it('declines when there is no capture', () => {
    expect(caseFromCapture(undefined, 'Webhook')).toBeUndefined();
  });

  it('declines when the workflow is only awaiting its first execution', () => {
    const awaiting: CaptureRecord = {
      capturedAt: '2026-09-07T00:00:00.000Z',
      awaitingFirstExecution: true,
    };
    expect(caseFromCapture(awaiting, 'Webhook')).toBeUndefined();
  });
});
