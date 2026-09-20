import { describe, expect, it } from 'vitest';
import { CodeEvalError, evaluateCode } from '../src/semantics/code-eval.js';

describe('evaluateCode', () => {
  it('returns the value the code returns', () => {
    expect(evaluateCode('return 1 + 1;', {}, 'Code')).toBe(2);
  });

  it('exposes what the context provides', () => {
    expect(evaluateCode('return $json.a;', { $json: { a: 5 } }, 'Code')).toBe(5);
  });

  it('keeps the standard library, which user code relies on', () => {
    expect(evaluateCode('return JSON.stringify([1, 2]);', {}, 'Code')).toBe('[1,2]');
  });

  it('cannot reach require', () => {
    expect(() => evaluateCode('return require("fs");', {}, 'Code')).toThrow(CodeEvalError);
  });

  it('cannot reach process', () => {
    expect(() => evaluateCode('return process.env;', {}, 'Code')).toThrow(CodeEvalError);
  });

  it('reports a syntax error against the node', () => {
    expect(() => evaluateCode('return {;', {}, 'Broken Code')).toThrow(/Broken Code/);
  });

  it('reports a thrown error against the node', () => {
    expect(() => evaluateCode('throw new Error("boom");', {}, 'Code')).toThrow(/boom/);
  });

  it('stops an endless loop at the timeout', () => {
    expect(() => evaluateCode('while (true) {}', {}, 'Code', 50)).toThrow(CodeEvalError);
  });

  it('does not leak between two evaluations', () => {
    evaluateCode('globalThis.leaked = 1; return 1;', {}, 'Code');
    expect(evaluateCode('return typeof globalThis.leaked;', {}, 'Code')).toBe('undefined');
  });
});
