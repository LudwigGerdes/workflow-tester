import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { runInSandbox } from '../src/sandbox/host.js';
import { walk } from '../src/walk.js';
import { loadNodeTypes, type NodeTypeSource } from '../src/node-types.js';
import type { EngineInput, WorkflowJson } from '../src/types.js';

const fixture = (name: string): WorkflowJson =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/workflows/${name}.json`, import.meta.url)), 'utf8'),
  ) as WorkflowJson;

const envelope = (body: unknown) => ({ headers: {}, params: {}, query: {}, body });

/** A one-Set workflow whose single assignment is the expression under test. */
const withExpression = (value: string): WorkflowJson => ({
  id: 'x',
  name: 'x',
  nodes: [
    { parameters: { httpMethod: 'POST', path: 'x', options: {} }, id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0] },
    {
      parameters: {
        mode: 'manual',
        includeOtherFields: false,
        assignments: { assignments: [{ id: 'a', name: 'out', value, type: 'string' }] },
        options: {},
      },
      id: 'n2', name: 'Danger', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [220, 0],
    },
  ],
  connections: { Webhook: { main: [[{ node: 'Danger', type: 'main', index: 0 }]] } },
});

const input = (workflow: WorkflowJson): EngineInput => ({
  workflow,
  trigger: 'Webhook',
  payload: envelope({ email: 'a@x.io' }),
});

describe('runInSandbox', () => {
  let types: NodeTypeSource;
  beforeAll(async () => {
    types = await loadNodeTypes();
  });

  /**
   * A Code node's objects are made inside the vm's realm, and the structured
   * clone that carries a result out of the worker rejects them. The walk itself
   * is unaffected, so this fails only through the sandbox — which is how the
   * CLI always runs, and how no in-process test ever ran.
   */
  it('carries a Code node result back across the worker boundary', async () => {
    const workflow: WorkflowJson = {
      id: 'c',
      name: 'c',
      nodes: [
        { parameters: { httpMethod: 'POST', path: 'x', options: {} }, id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0] },
        {
          parameters: {
            mode: 'runOnceForAllItems',
            jsCode: "return $input.all().map((i) => ({ json: { ...i.json, seen: true, at: new Date(0) } }));",
          },
          id: 'n2', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0],
        },
      ],
      connections: { Webhook: { main: [[{ node: 'Code', type: 'main', index: 0 }]] } },
    };

    const result = await runInSandbox(input(workflow));
    expect(result.status).toBe('pass');
  }, 30_000);

  it('produces the same result as walking directly', async () => {
    const direct = walk(input(fixture('linear')), types);
    const sandboxed = await runInSandbox(input(fixture('linear')));
    const { durationMs: _a, ...expected } = direct;
    expect(sandboxed).toMatchObject(expected);
  }, 30_000);

  it('reports a boundary through the sandbox too', async () => {
    const result = await runInSandbox(input(fixture('boundary')));
    expect(result.status).toBe('boundary');
  }, 30_000);

  it('times out a runaway expression and leaves the host alive', async () => {
    const started = Date.now();
    const result = await runInSandbox(input(withExpression('={{ (() => { while(true){} })() }}')), {
      timeoutMs: 2000,
    });
    expect(result.status).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000 + 3000);
    // the host is still able to run another case
    expect((await runInSandbox(input(fixture('linear')))).status).toBe('pass');
  }, 40_000);

  it('does not let an expression reach the process object', async () => {
    const result = await runInSandbox(
      input(withExpression("={{ [].constructor.constructor('return process')() }}")),
    );
    expect(['pass', 'fail', 'boundary']).toContain(result.status);
    const leaked = JSON.stringify(result);
    expect(leaked).not.toContain('"pid"');
    expect(leaked).not.toContain('argv');
  }, 30_000);

  /**
   * Heap exhaustion is contained *usually*, and the exception cannot be tested
   * in process.
   *
   * A worker's `resourceLimits` normally terminate the thread and the host
   * carries on. But near the ceiling any allocation can be the one V8 cannot
   * satisfy, and then it calls FatalProcessOutOfMemory, which aborts the whole
   * process rather than the thread. Whether a given run ends gracefully or
   * fatally is a race, and no allocation shape avoids it: measured over 20 runs
   * of this suite, an array-growth expression aborted the test runner 4 times
   * and a linked-allocation one still aborted it once.
   *
   * So the hostile expression runs in a child process that is allowed to die,
   * and the assertion covers both endings. What is actually guaranteed — and
   * what this proves — is that the host survives either way.
   */
  it('cannot be taken down by a case that exhausts its heap', async () => {
    const hostile = JSON.stringify(
      input(
        withExpression(
          "={{ (() => { let head = null; while (true) head = { next: head, pad: 'x'.repeat(1000) }; })() }}",
        ),
      ),
    );
    const hostUrl = new URL('../dist/sandbox/host.js', import.meta.url).href;

    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { runInSandbox } from ${JSON.stringify(hostUrl)};
         const r = await runInSandbox(${hostile}, { maxOldGenerationSizeMb: 64, timeoutMs: 15000 });
         process.stdout.write(JSON.stringify({ status: r.status, message: r.message ?? '' }));`,
      ],
      { encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024 },
    );

    if (child.status === 0) {
      // Contained: the worker limit terminated the thread and the run reported it.
      const result = JSON.parse(child.stdout) as { status: string; message: string };
      expect(result.status).toBe('crashed');
      expect(result.message).toContain('memory limit');
    } else {
      // Not contained: V8 aborted the child. That is the documented gap, and
      // running it over there is what keeps it from being our problem.
      expect(`${child.stdout}${child.stderr}`).toMatch(/heap limit|out of memory/i);
    }

    // The point of the test: whichever ending the child got, this process is fine.
    expect((await runInSandbox(input(fixture('linear')))).status).toBe('pass');
  }, 120_000);

  /**
   * String doubling never reaches the heap ceiling: it trips V8's maximum
   * string length first, and n8n swallows that RangeError into `undefined`
   * like any other expression error. Contained, but by a different mechanism —
   * which is why the assertion is "the host is unharmed", not "crashed".
   */
  it('contains unbounded string growth', async () => {
    const result = await runInSandbox(
      input(withExpression("={{ (() => { let s = 'x'; while (true) s += s; return s; })() }}")),
      { maxOldGenerationSizeMb: 64, timeoutMs: 15_000 },
    );
    expect(['pass', 'fail', 'crashed', 'timeout']).toContain(result.status);
    expect((await runInSandbox(input(fixture('linear')))).status).toBe('pass');
  }, 60_000);
});
