import { describe, expect, it } from 'vitest';
import { workerUrl } from '../src/sandbox/host.js';

describe('where the sandbox worker is loaded from', () => {
  it('is the tsc output when the host runs from TypeScript', () => {
    const url = workerUrl('file:///repo/packages/engine/src/sandbox/host.ts', () => false);
    expect(url.pathname).toBe('/repo/packages/engine/dist/sandbox/worker.js');
  });

  it('is the sibling file in the tsc layout', () => {
    const url = workerUrl('file:///repo/packages/engine/dist/sandbox/host.js', () => false);
    expect(url.pathname).toBe('/repo/packages/engine/dist/sandbox/worker.js');
  });

  it('is its own entry point beside the bundle in the published package', () => {
    const url = workerUrl(
      'file:///app/node_modules/payload-contract/dist/chunk-ABC.js',
      (candidate) => candidate.pathname.endsWith('/dist/sandbox-worker.js'),
    );
    expect(url.pathname).toBe('/app/node_modules/payload-contract/dist/sandbox-worker.js');
  });
});
