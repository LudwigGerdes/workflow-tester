import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { run } from '../src/index.js';
import type { Io } from '../src/io.js';

let dir: string;
let out: string[];
let err: string[];
const io = (mode?: string): Io => ({
  cwd: dir,
  out: (s: string) => out.push(s),
  err: (s: string) => err.push(s),
  ...(mode === undefined ? {} : { env: { WORKFLOW_TESTER_MODE: mode } }),
});
const stdout = () => out.join('\n');

const WORKFLOW = {
  id: 'w',
  name: 'invoice',
  nodes: [
    {
      parameters: { httpMethod: 'POST', path: 'w', options: {} },
      id: 'n1',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 0],
    },
    {
      parameters: {
        mode: 'manual',
        includeOtherFields: false,
        assignments: {
          assignments: [{ id: 'a', name: 'who', value: '={{ $json.body.name }}', type: 'string' }],
        },
        options: {},
      },
      id: 'n2',
      name: 'Extract',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [220, 0],
    },
  ],
  connections: { Webhook: { main: [[{ node: 'Extract', type: 'main', index: 0 }]] } },
};

const SCHEMA = {
  type: 'object',
  properties: {
    body: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  required: ['body'],
};

const EXAMPLES = [{ body: { name: 'Ada' } }];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-tester-mode-'));
  out = [];
  err = [];
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  mkdirSync(join(dir, '.workflow-tester/contracts'), { recursive: true });
  writeFileSync(join(dir, 'workflows/invoice.json'), JSON.stringify(WORKFLOW, null, 2));
  writeFileSync(
    join(dir, 'workflows/invoice.contract.yaml'),
    [
      'version: 1',
      'trigger: Webhook',
      'source:',
      '  kind: vendor',
      '  vendor: stripe',
      '  events:',
      '    - demo.event',
      'shape:',
      '  schema: ../.workflow-tester/contracts/demo.schema.json',
      '  examples: ../.workflow-tester/contracts/demo.examples.json',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, '.workflow-tester/contracts/demo.schema.json'), JSON.stringify(SCHEMA));
  writeFileSync(join(dir, '.workflow-tester/contracts/demo.examples.json'), JSON.stringify(EXAMPLES));
});

describe('gen and the mode', () => {
  /**
   * `gen` writes: that is what the command is for, and a `gen` that refused
   * to unless an environment variable said so told users to run the command
   * they had just run. `--check` is the read-only form, in every mode.
   */
  const indexFile = () => join(dir, '.workflow-tester/cases/invoice/demo/index.json');

  it('writes cases in dev', async () => {
    expect(await run(['gen'], io('dev'))).toBe(0);
    expect(stdout()).not.toMatch(/would change|stale/i);
    expect(existsSync(indexFile())).toBe(true);
  });

  it('writes cases in test mode too', async () => {
    expect(await run(['gen'], io('test'))).toBe(0);
    expect(existsSync(indexFile())).toBe(true);
  });

  it('writes cases when nothing is set', async () => {
    expect(await run(['gen'], io())).toBe(0);
    expect(existsSync(indexFile())).toBe(true);
    expect(stdout()).toMatch(/added/);
  });

  it('--check writes nothing and fails on staleness, in any mode', async () => {
    expect(await run(['gen', '--check'], io('dev'))).toBe(1);
    expect(existsSync(indexFile())).toBe(false);
    expect(await run(['gen', '--check'], io())).toBe(1);
    expect(existsSync(indexFile())).toBe(false);
  });

  it('is idempotent in dev: a second run has nothing to change', async () => {
    expect(await run(['gen'], io('dev'))).toBe(0);
    out = [];
    expect(await run(['gen', '--check'], io('dev'))).toBe(0);
  });
});

describe('capture and the mode', () => {
  const EXEC = (name: unknown) => ({
    id: '1',
    workflowData: { nodes: [{ name: 'Webhook', id: 'n1' }, { name: 'Extract', id: 'n2' }] },
    data: {
      resultData: {
        runData: {
          Webhook: [{ data: { main: [[{ json: { body: { name: 'Ada' } } }]] } }],
          Extract: [{ data: { main: [[{ json: { who: name } }]] } }],
        },
      },
    },
  });

  /** The recorded type of Extract's `who` field, read off the sidecar. */
  const capturedType = (): unknown => {
    const doc = parseYaml(readFileSync(join(dir, 'workflows/invoice.contract.yaml'), 'utf8')) as {
      capture?: {
        nodes?: Record<string, { shape?: { fields?: Record<string, { type?: unknown }> } }>;
      };
    } | null;
    return doc?.capture?.nodes?.['Extract']?.shape?.fields?.['who']?.type;
  };

  beforeEach(() => {
    writeFileSync(join(dir, 'first.json'), JSON.stringify(EXEC('Ada')));
    writeFileSync(join(dir, 'second.json'), JSON.stringify(EXEC(42)));
  });

  it('records the first capture in either mode', async () => {
    expect(
      await run(['capture', 'workflows/invoice.json', '--execution', 'first.json'], io('test')),
    ).toBe(0);
    expect(capturedType()).toBe('string');
  });

  it('reports drift and refuses to replace in test', async () => {
    await run(['capture', 'workflows/invoice.json', '--execution', 'first.json'], io('test'));
    out = [];
    expect(
      await run(['capture', 'workflows/invoice.json', '--execution', 'second.json'], io('test')),
    ).toBe(0);
    expect(stdout()).toMatch(/changed shape/);
    expect(stdout()).toMatch(/--update/);
    expect(capturedType()).toBe('string');
  });

  it('reports drift and accepts it in dev', async () => {
    await run(['capture', 'workflows/invoice.json', '--execution', 'first.json'], io('dev'));
    out = [];
    expect(
      await run(['capture', 'workflows/invoice.json', '--execution', 'second.json'], io('dev')),
    ).toBe(0);
    expect(stdout()).toMatch(/changed shape/);
    expect(capturedType()).toBe('number');
  });

  it('lets an explicit --update beat test mode', async () => {
    await run(['capture', 'workflows/invoice.json', '--execution', 'first.json'], io('test'));
    out = [];
    await run(
      ['capture', 'workflows/invoice.json', '--execution', 'second.json', '--update'],
      io('test'),
    );
    expect(capturedType()).toBe('number');
  });
});

describe('run ignores the mode', () => {
  /**
   * Mode governs what is *written*, never what counts as a pass. A green run on
   * a developer's machine has to mean exactly what a green run in CI means, or
   * neither is evidence of anything.
   */

  // The report ends with "... in 340ms" (reporters/index.ts:67), so raw stdout
  // differs between two runs of the same thing. Normalising the duration is
  // what makes this a test about mode rather than about timing.
  const stable = (text: string): string => text.replace(/in \d+ms/g, 'in <duration>');

  const bothModes = async (argv: string[]) => {
    out = [];
    err = [];
    const dev = await run(argv, io('dev'));
    const devSaid = stable(stdout());
    out = [];
    err = [];
    const test = await run(argv, io('test'));
    return { dev, test, devSaid, testSaid: stable(stdout()) };
  };

  it('agrees on a workflow whose cases all pass', async () => {
    await run(['gen'], io('dev'));
    const { dev, test, devSaid, testSaid } = await bothModes(['run']);
    expect(dev).toBe(test);
    expect(devSaid).toBe(testSaid);
  });

  it('agrees when there is nothing to run', async () => {
    const { dev, test, devSaid, testSaid } = await bothModes(['run']);
    expect(dev).toBe(test);
    expect(devSaid).toBe(testSaid);
  });

  it('agrees on a workflow with a capture and no cases', async () => {
    writeFileSync(
      join(dir, 'first.json'),
      JSON.stringify({
        id: '1',
        workflowData: { nodes: [{ name: 'Webhook', id: 'n1' }, { name: 'Extract', id: 'n2' }] },
        data: {
          resultData: {
            runData: {
              Webhook: [{ data: { main: [[{ json: { body: { name: 'Ada' } } }]] } }],
              Extract: [{ data: { main: [[{ json: { who: 'ada' } }]] } }],
            },
          },
        },
      }),
    );
    await run(['capture', 'workflows/invoice.json', '--execution', 'first.json'], io('dev'));
    const { dev, test, devSaid, testSaid } = await bothModes(['run']);
    expect(dev).toBe(test);
    expect(devSaid).toBe(testSaid);
  });
});
