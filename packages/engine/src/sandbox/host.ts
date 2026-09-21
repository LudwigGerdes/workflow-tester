import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { EngineInput, EngineResult } from '../types.js';
import type { WorkerError } from './worker.js';

export interface SandboxFailure {
  status: 'timeout' | 'crashed';
  message: string;
}

export type SandboxResult = EngineResult | SandboxFailure;

export interface SandboxOptions {
  /** Wall-clock budget for one case. */
  timeoutMs?: number;
  /** Heap ceiling; exceeding it kills the thread, not the host. */
  maxOldGenerationSizeMb?: number;
  n8nVersion?: string;
}

/**
 * The worker always runs *built* JavaScript, even when the host is loaded from
 * TypeScript under vitest.
 *
 * A worker thread cannot load our sources directly: Node 22's native type
 * stripping runs the `.ts` entry but does not rewrite the `.js` specifiers
 * NodeNext requires, and tsx's resolver hooks do not register through a
 * worker's `execArgv` (verified both with and without `--no-experimental-strip-
 * types`). Pointing at `dist` removes the loader question entirely and has the
 * sandbox tests exercise exactly what ships. `test/global-setup.ts` builds the
 * package before the suite runs so `pnpm test` stays self-sufficient.
 *
 * The worker is a file loaded by path, so it is located relative to this
 * module in each of the three places this module can be:
 *
 * - `src/sandbox/host.ts` (vitest): the tsc output, `../../dist/sandbox/worker.js`.
 * - `dist/sandbox/host.js` (tsc): its sibling `./worker.js`.
 * - bundled into the published CLI, `<package>/dist/*.js`: the worker is its
 *   own entry point of the same bundle, `./sandbox-worker.js`. Never resolved
 *   through a package name: the published package has no workspace libraries
 *   beside it to resolve.
 */
export function workerUrl(
  from: string = import.meta.url,
  exists: (url: URL) => boolean = existsSync,
): URL {
  if (from.endsWith('.ts')) return new URL('../../dist/sandbox/worker.js', from);
  const bundled = new URL('./sandbox-worker.js', from);
  return exists(bundled) ? bundled : new URL('./worker.js', from);
}

const WORKER_URL = workerUrl();

/**
 * Per-case wall clock budget.
 *
 * The point is to stop a runaway expression, not to police normal work, so it
 * is set well clear of what a case actually costs. At 2000ms a 200-case
 * generated suite timed out 0, 9, 6 and 5 cases across four runs of an
 * identical repository — nothing wrong with those cases, just worker startup
 * spread under parallel load. A budget that fails a case for being unlucky
 * teaches people to rerun until green.
 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Evaluate one case in a worker thread with a wall-clock timeout and a heap
 * ceiling.
 *
 * The threat model is a pathological or malicious *expression*, not a payload:
 * payloads are inert JSON that never reach an evaluator. n8n's own tournament
 * evaluator applies its prototype and `$`-access sanitizers; this adds the
 * guarantees it cannot give — a runaway expression cannot hang the run, and
 * runaway heap growth kills the thread rather than the host.
 *
 * KNOWN GAP: worker `resourceLimits` do not contain a *single* oversized
 * allocation. `={{ Array(1e9).fill('x') }}` makes V8 call
 * FatalProcessOutOfMemory, which aborts the entire process — verified at a
 * 64 MB ceiling. Gradual growth is contained cleanly ("Worker terminated due to
 * reaching memory limit"), and string doubling trips V8's maximum string length
 * first, but one hostile expression of that shape can still take a run down.
 * Closing it needs process isolation rather than a thread, which trades roughly
 * an order of magnitude of spawn cost against the ≥500 cases/s target in spec
 * §5; recorded here as a deliberate, measured phase-0 limitation.
 */
export async function runInSandbox(
  input: EngineInput,
  options: SandboxOptions = {},
): Promise<SandboxResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxOldGenerationSizeMb = 256, n8nVersion } = options;
  if (!existsSync(WORKER_URL)) {
    throw new Error(
      `sandbox worker not built at ${WORKER_URL.pathname} — run \`pnpm build\` in packages/engine`,
    );
  }

  return await new Promise<SandboxResult>((resolve) => {
    const worker = new Worker(WORKER_URL, {
      workerData: { ...input, n8nVersion: n8nVersion ?? input.n8nVersion },
      resourceLimits: { maxOldGenerationSizeMb },
      // Explicitly empty, not inherited: a worker otherwise picks up the
      // parent's execArgv, and under vitest that carries `--conditions
      // development`, which resolves the node-type bundle to its TypeScript
      // sources instead of its built output.
      execArgv: [],
    });

    let settled = false;
    const finish = (result: SandboxResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ status: 'timeout', message: `case exceeded ${timeoutMs}ms` }),
      timeoutMs,
    );

    worker.on('message', (message: EngineResult | WorkerError) => {
      if ('__workflowTestError' in message) {
        finish({ status: 'crashed', message: message.__workflowTestError });
        return;
      }
      finish(message);
    });

    worker.on('error', (error: Error) => {
      finish({ status: 'crashed', message: error.message });
    });

    worker.on('exit', (code) => {
      if (code !== 0) finish({ status: 'crashed', message: `worker exited with code ${code}` });
    });
  });
}
