import { describe, expect, it } from 'vitest';
import { modeOf } from '../src/mode.js';
import type { Io } from '../src/io.js';

const io = (env?: Record<string, string | undefined>): Io => ({
  cwd: '/tmp',
  out: () => {},
  err: () => {},
  ...(env === undefined ? {} : { env }),
});

describe('modeOf', () => {
  it('is test when nothing is set', () => {
    expect(modeOf(io())).toBe('test');
  });

  it('is test when the variable is empty', () => {
    expect(modeOf(io({ WORKFLOW_TESTER_MODE: '' }))).toBe('test');
  });

  it('is dev when asked for', () => {
    expect(modeOf(io({ WORKFLOW_TESTER_MODE: 'dev' }))).toBe('dev');
  });

  it('is test when asked for', () => {
    expect(modeOf(io({ WORKFLOW_TESTER_MODE: 'test' }))).toBe('test');
  });

  it('ignores case and surrounding space', () => {
    expect(modeOf(io({ WORKFLOW_TESTER_MODE: '  DEV ' }))).toBe('dev');
  });

  it('falls back to test on an unrecognised value, and says so', () => {
    const said: string[] = [];
    const noisy: Io = {
      cwd: '/tmp',
      out: () => {},
      err: (s) => said.push(s),
      env: { WORKFLOW_TESTER_MODE: 'yolo' },
    };
    expect(modeOf(noisy)).toBe('test');
    expect(said.join('\n')).toMatch(/yolo/);
    expect(said.join('\n')).toMatch(/test/);
  });

  it('says nothing when the value is valid', () => {
    const said: string[] = [];
    const quiet: Io = {
      cwd: '/tmp',
      out: () => {},
      err: (s) => said.push(s),
      env: { WORKFLOW_TESTER_MODE: 'dev' },
    };
    modeOf(quiet);
    expect(said).toEqual([]);
  });
});
