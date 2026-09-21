import { mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { run } from '../src/index.js';

let dir: string;
let out: string[];
let err: string[];

const io = () => ({
  cwd: dir,
  out: (s: string) => out.push(s),
  err: (s: string) => err.push(s),
});

const stdout = () => out.join('\n');
const stderr = () => err.join('\n');

const webhook = (name: string) => ({
  parameters: { httpMethod: 'POST', path: name, options: {} },
  id: name,
  name,
  type: 'n8n-nodes-base.webhook',
  typeVersion: 2,
  position: [0, 0],
});

const writeWorkflow = (file: string, nodes: unknown[]): string => {
  const path = join(dir, file);
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  writeFileSync(path, JSON.stringify({ id: 'w', name: 'w', nodes, connections: {} }, null, 2));
  return path;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-tester-cli-'));
  out = [];
  err = [];
});

describe('vendors', () => {
  it('lists every vendor with its coverage', async () => {
    expect(await run(['vendors', 'list'], io())).toBe(0);
    expect(stdout()).toMatch(/github/);
    expect(stdout()).toMatch(/stripe/);
    expect(stdout()).toMatch(/slack/);
    expect(stdout()).toMatch(/1\.1\.4/);
  });

  it('prints the audit', async () => {
    expect(await run(['vendors', 'audit'], io())).toBe(0);
    expect(stdout()).toMatch(/Vendor coverage audit/);
  });
});

describe('contracts add', () => {
  it('writes a contract and its shape files beside the workflow', async () => {
    const wf = writeWorkflow('workflows/invoice.json', [webhook('Webhook')]);
    const code = await run(
      ['contracts', 'add', wf, '--vendor', 'stripe', '--events', 'invoice.paid,invoice.payment_failed'],
      io(),
    );

    expect(code).toBe(0);
    const contractFile = join(dir, 'workflows/invoice.contract.yaml');
    expect(existsSync(contractFile)).toBe(true);
    expect(readFileSync(contractFile, 'utf8')).toContain('vendor: stripe');
    expect(existsSync(join(dir, '.workflow-tester/contracts/stripe.invoice.schema.json'))).toBe(true);
    expect(existsSync(join(dir, '.workflow-tester/contracts/stripe.invoice.examples.json'))).toBe(true);
    expect(stdout()).toMatch(/invoice\.paid/);
  });

  it('infers the trigger when the workflow has exactly one webhook', async () => {
    const wf = writeWorkflow('workflows/one.json', [webhook('Incoming')]);
    expect(await run(['contracts', 'add', wf, '--vendor', 'stripe', '--events', 'invoice.paid'], io())).toBe(0);
    expect(readFileSync(join(dir, 'workflows/one.contract.yaml'), 'utf8')).toContain('trigger: Incoming');
  });

  it('refuses to guess between two webhooks', async () => {
    const wf = writeWorkflow('workflows/two.json', [webhook('A'), webhook('B')]);
    const code = await run(['contracts', 'add', wf, '--vendor', 'stripe', '--events', 'invoice.paid'], io());
    expect(code).toBe(2);
    expect(stderr()).toMatch(/--trigger/);
    expect(stderr()).toMatch(/A.*B|B.*A/s);
  });

  it('errors when the workflow has no webhook at all', async () => {
    const wf = writeWorkflow('workflows/none.json', []);
    expect(await run(['contracts', 'add', wf, '--vendor', 'stripe', '--events', 'invoice.paid'], io())).toBe(2);
    expect(stderr()).toMatch(/no webhook/i);
  });

  it('rejects an unknown vendor with exit code 2', async () => {
    const wf = writeWorkflow('workflows/x.json', [webhook('Webhook')]);
    expect(await run(['contracts', 'add', wf, '--vendor', 'nope', '--events', 'a'], io())).toBe(2);
    expect(stderr()).toMatch(/nope/);
  });

  it('is idempotent', async () => {
    const wf = writeWorkflow('workflows/idem.json', [webhook('Webhook')]);
    const args = ['contracts', 'add', wf, '--vendor', 'stripe', '--events', 'invoice.paid'];
    await run(args, io());
    const before = {
      contract: readFileSync(join(dir, 'workflows/idem.contract.yaml'), 'utf8'),
      schema: readFileSync(join(dir, '.workflow-tester/contracts/stripe.invoice.paid.schema.json'), 'utf8'),
    };
    expect(await run(args, io())).toBe(0);
    expect(readFileSync(join(dir, 'workflows/idem.contract.yaml'), 'utf8')).toBe(before.contract);
    expect(readFileSync(join(dir, '.workflow-tester/contracts/stripe.invoice.paid.schema.json'), 'utf8')).toBe(
      before.schema,
    );
  });
});

describe('contracts update', () => {
  it('re-materialises without changing a byte', async () => {
    const wf = writeWorkflow('workflows/upd.json', [webhook('Webhook')]);
    await run(['contracts', 'add', wf, '--vendor', 'stripe', '--events', 'invoice.paid'], io());
    const before = readFileSync(join(dir, '.workflow-tester/contracts/stripe.invoice.paid.schema.json'), 'utf8');

    out = [];
    expect(await run(['contracts', 'update', '--all'], io())).toBe(0);
    expect(readFileSync(join(dir, '.workflow-tester/contracts/stripe.invoice.paid.schema.json'), 'utf8')).toBe(before);
  });

  it('reports when there is nothing to update', async () => {
    expect(await run(['contracts', 'update', '--all'], io())).toBe(0);
    expect(stdout()).toMatch(/no contracts/i);
  });
});

describe('usage', () => {
  it('prints help and exits 0 for --help', async () => {
    expect(await run(['--help'], io())).toBe(0);
    expect(stdout()).toMatch(/contracts add/);
  });

  it('exits 2 on an unknown command', async () => {
    expect(await run(['nonsense'], io())).toBe(2);
    expect(stderr()).toMatch(/nonsense/);
  });

  const COMMANDS = [
    'contracts',
    'gen',
    'run',
    'explain',
    'schema',
    'init',
    'promote',
    'capture',
    'sync',
    'vendors',
    'node-types',
  ];

  it.each(COMMANDS)('%s --help prints that command\'s usage and exits 0', async (command) => {
    expect(await run([command, '--help'], io())).toBe(0);
    expect(stdout()).toMatch(new RegExp(`workflow-tester ${command}`));
    expect(stderr()).toBe('');
    // Usage only: nothing scaffolded, run, or written.
    expect(existsSync(join(dir, '.workflow-tester'))).toBe(false);
  });

  it.each(COMMANDS)('%s -h is the same as --help', async (command) => {
    expect(await run([command, '-h'], io())).toBe(0);
    expect(stdout()).toMatch(new RegExp(`workflow-tester ${command}`));
  });

  it('help <command> prints that command\'s usage', async () => {
    expect(await run(['help', 'run'], io())).toBe(0);
    expect(stdout()).toMatch(/workflow-tester run/);
    expect(stdout()).not.toMatch(/workflow-tester capture/);
  });

  it('a subcommand honours --help too', async () => {
    expect(await run(['contracts', 'add', '--help'], io())).toBe(0);
    expect(stdout()).toMatch(/workflow-tester contracts add/);
  });

  it('prints the version for --version and -v', async () => {
    expect(await run(['--version'], io())).toBe(0);
    expect(stdout()).toMatch(/^workflow-tester \d+\.\d+\.\d+/);
    out = [];
    expect(await run(['-v'], io())).toBe(0);
    expect(stdout()).toMatch(/^workflow-tester \d+\.\d+\.\d+/);
  });
});

describe('run with an explicit target', () => {
  it('exits 2 with a one-line error when the workflow file does not exist', async () => {
    expect(await run(['run', 'workflows/nope.json'], io())).toBe(2);
    expect(err).toHaveLength(1);
    expect(stderr()).toMatch(/workflows\/nope\.json/);
    expect(stdout()).not.toMatch(/passed/);
  });

  it('exits 2 when the workflow file is not JSON', async () => {
    mkdirSync(join(dir, 'workflows'), { recursive: true });
    writeFileSync(join(dir, 'workflows/bad.json'), '{ not json');
    expect(await run(['run', 'workflows/bad.json'], io())).toBe(2);
    expect(stderr()).toMatch(/workflows\/bad\.json/);
  });

  it('still runs a workflow that exists', async () => {
    writeWorkflow('workflows/ok.json', [webhook('Webhook')]);
    expect(await run(['run', 'workflows/ok.json'], io())).toBe(0);
    expect(stdout()).toMatch(/0 passed/);
  });
});

describe('contracts add validates before it writes', () => {
  const contract = () => join(dir, 'workflows/invoice.contract.yaml');

  it('leaves nothing behind when an event is unknown', async () => {
    const wf = writeWorkflow('workflows/invoice.json', [webhook('Webhook')]);
    expect(await run(['contracts', 'add', wf, '--vendor', 'github', '--events', 'issues'], io())).toBe(2);
    expect(stderr()).toMatch(/no materialised event "issues"/);
    expect(existsSync(contract())).toBe(false);
    expect(existsSync(join(dir, '.workflow-tester/contracts'))).toBe(false);
    expect(readdirSync(join(dir, 'workflows'))).toEqual(['invoice.json']);
  });

  it('succeeds on retry with the right events, with no file to delete first', async () => {
    const wf = writeWorkflow('workflows/invoice.json', [webhook('Webhook')]);
    await run(['contracts', 'add', wf, '--vendor', 'github', '--events', 'issues'], io());
    out = [];
    err = [];
    expect(
      await run(['contracts', 'add', wf, '--vendor', 'github', '--events', 'issues-opened'], io()),
    ).toBe(0);
    expect(readFileSync(contract(), 'utf8')).toContain('- issues-opened');
  });

  it('lets a later --events replace the events in an existing contract', async () => {
    const wf = writeWorkflow('workflows/invoice.json', [webhook('Webhook')]);
    await run(['contracts', 'add', wf, '--vendor', 'stripe', '--events', 'invoice.paid'], io());
    // A hand edit that must survive the rewrite.
    writeFileSync(
      contract(),
      readFileSync(contract(), 'utf8').replace('# overrides:', 'overrides:\n  never: [data.object.lines]\n# overrides:'),
    );
    out = [];
    expect(
      await run(['contracts', 'add', wf, '--vendor', 'stripe', '--events', 'invoice.payment_failed'], io()),
    ).toBe(0);
    const text = readFileSync(contract(), 'utf8');
    expect(text).toContain('- invoice.payment_failed');
    expect(text).not.toContain('- invoice.paid');
    // Comments and the hand-edited section survive (the yaml library may
    // reflow a sequence; what matters is that nothing is lost).
    expect(text).toContain('# The only hand-edited section');
    expect((parseYaml(text) as { overrides?: { never?: unknown } }).overrides?.never).toEqual(['data.object.lines']);
    expect(stdout()).toMatch(/invoice\.payment_failed/);
    expect(stdout()).toMatch(/was stripe: invoice\.paid/);
  });

  it('keeps an existing contract intact when the new events are invalid', async () => {
    const wf = writeWorkflow('workflows/invoice.json', [webhook('Webhook')]);
    await run(['contracts', 'add', wf, '--vendor', 'stripe', '--events', 'invoice.paid'], io());
    const before = readFileSync(contract(), 'utf8');
    expect(await run(['contracts', 'add', wf, '--vendor', 'stripe', '--events', 'nope'], io())).toBe(2);
    expect(readFileSync(contract(), 'utf8')).toBe(before);
    expect(readdirSync(join(dir, 'workflows')).sort()).toEqual(['invoice.contract.yaml', 'invoice.json']);
  });
});
