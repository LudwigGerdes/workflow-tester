import { parentPort, workerData } from 'node:worker_threads';
import { loadNodeTypes } from '../node-types.js';
import type { EngineInput } from '../types.js';
import { walk } from '../walk.js';

/** Posted instead of a result when the walk itself could not complete. */
export interface WorkerError {
  __payloadContractError: string;
}

async function main(): Promise<void> {
  const input = workerData as EngineInput;
  // Loaded inside the worker and cached there by version, so a pool of workers
  // pays the bundle read once each rather than once per case.
  const types = await loadNodeTypes(input.n8nVersion);
  parentPort?.postMessage(walk(input, types));
}

main().catch((error: unknown) => {
  const message: WorkerError = {
    __payloadContractError: error instanceof Error ? error.message : String(error),
  };
  parentPort?.postMessage(message);
});
