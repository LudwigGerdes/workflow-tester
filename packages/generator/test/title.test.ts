import { describe, expect, it } from 'vitest';
import { titleOf } from '../src/generate.js';

describe('titleOf', () => {
  it('joins kind, path and detail', () => {
    expect(titleOf([{ kind: 'format-edge', path: 'body.issue.title', detail: 'empty' }])).toBe(
      'format-edge body.issue.title (empty)',
    );
    expect(titleOf([{ kind: 'nullable-null', path: 'body.a', detail: '' }, { kind: 'nullable-null', path: 'body.b', detail: '' }])).toBe(
      'nullable-null body.a + nullable-null body.b',
    );
  });

  it('leaves no double space when the change is at the payload root', () => {
    expect(titleOf([{ kind: 'oneOf-branch', path: '', detail: 'branch 0' }])).toBe('oneOf-branch (branch 0)');
  });
});
