import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from 'workflow-test-vendors';
import { beforeEach, describe, expect, it } from 'vitest';
import { materialize } from '../src/materialize.js';
import { readContract } from '../src/read.js';
import type { Contract } from '../src/types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-test-materialize-'));
});

const writeContract = (body: string): string => {
  const file = join(dir, 'wf.contract.yaml');
  writeFileSync(file, body);
  return file;
};

const stripeContract = (events: string[]): string =>
  writeContract(
    `version: 1\ntrigger: Webhook\n# keep me\nsource:\n  kind: vendor\n  vendor: stripe\n  events:\n${events
      .map((e) => `    - ${e}`)
      .join('\n')}\n`,
  );

describe('materialize', () => {
  it('writes a single event as one schema plus its examples', async () => {
    const file = stripeContract(['invoice.paid']);
    const { contract } = await readContract(file);
    const result = await materialize(contract, loadCatalog('stripe'), {
      outDir: join(dir, '.workflow-test/contracts'),
      contractDir: dir,
      contractFile: file,
    });

    expect(result.events).toEqual(['invoice.paid']);
    expect(result.specVersion).toBe('2026-08-26.dahlia');
    expect(result.shape?.schema).toMatch(/^\.workflow-test\/contracts\/stripe\./);

    const schema = JSON.parse(readFileSync(join(dir, result.shape?.schema ?? ''), 'utf8')) as {
      properties: { type: { const: string } };
    };
    expect(schema.properties.type.const).toBe('invoice.paid');
  });

  it('combines several events into a oneOf with a discriminator per branch', async () => {
    const file = stripeContract(['invoice.paid', 'invoice.payment_failed']);
    const { contract } = await readContract(file);
    const result = await materialize(contract, loadCatalog('stripe'), {
      outDir: join(dir, '.workflow-test/contracts'),
      contractDir: dir,
      contractFile: file,
    });

    const schema = JSON.parse(readFileSync(join(dir, result.shape?.schema ?? ''), 'utf8')) as {
      oneOf: Array<{ properties: { type: { const: string } }; 'x-workflow-test-event': string }>;
    };
    expect(schema.oneOf).toHaveLength(2);
    expect(schema.oneOf.map((b) => b.properties.type.const)).toEqual([
      'invoice.paid',
      'invoice.payment_failed',
    ]);
    expect(schema.oneOf.map((b) => b['x-workflow-test-event'])).toEqual([
      'invoice.paid',
      'invoice.payment_failed',
    ]);
  });

  it('tags every example with the event it came from', async () => {
    const file = writeContract(
      'version: 1\ntrigger: Webhook\nsource:\n  kind: vendor\n  vendor: github\n  events:\n    - ping\n    - push\n',
    );
    const { contract } = await readContract(file);
    const result = await materialize(contract, loadCatalog('github'), {
      outDir: join(dir, '.workflow-test/contracts'),
      contractDir: dir,
      contractFile: file,
    });

    const examples = JSON.parse(readFileSync(join(dir, result.shape?.examples ?? ''), 'utf8')) as Array<{
      event: string;
      payload: unknown;
    }>;
    // Both events now carry a real payload — ping's from the REST description,
    // push's from octokit's published set — so each contributes one, tagged
    // with the event it came from.
    expect(examples.map((e) => e.event)).toEqual(['ping', 'push']);
    expect(examples[0]?.payload).toMatchObject({ zen: expect.any(String) });
    expect(examples[1]?.payload).toMatchObject({ commits: expect.any(Array) });
    // and nothing is warned about, because nothing has to be synthesised
    expect(result.warnings).toEqual([]);
  });

  it('refuses an unknown event and says what is available', async () => {
    const file = stripeContract(['invoice.exploded']);
    const { contract } = await readContract(file);
    await expect(
      materialize(contract, loadCatalog('stripe'), {
        outDir: join(dir, '.workflow-test/contracts'),
        contractDir: dir,
        contractFile: file,
      }),
    ).rejects.toThrow(/invoice\.exploded.*invoice\.paid/s);
  });

  it('restricts to overrides.only', async () => {
    const file = writeContract(
      'version: 1\ntrigger: Webhook\nsource:\n  kind: vendor\n  vendor: stripe\n  events:\n    - invoice.paid\n    - invoice.payment_failed\noverrides:\n  only:\n    - invoice.paid\n',
    );
    const { contract } = await readContract(file);
    const result = await materialize(contract, loadCatalog('stripe'), {
      outDir: join(dir, '.workflow-test/contracts'),
      contractDir: dir,
      contractFile: file,
    });
    expect(result.events).toEqual(['invoice.paid']);
  });

  it('writes the shape back into the contract without disturbing the rest', async () => {
    const file = stripeContract(['invoice.paid']);
    const { contract } = await readContract(file);
    await materialize(contract, loadCatalog('stripe'), {
      outDir: join(dir, '.workflow-test/contracts'),
      contractDir: dir,
      contractFile: file,
    });

    const rewritten = readFileSync(file, 'utf8');
    expect(rewritten).toContain('# keep me');
    const reread = await readContract(file);
    expect(reread.contract.shape?.schema).toMatch(/stripe\./);
  });

  it('is byte-for-byte idempotent', async () => {
    const file = stripeContract(['invoice.paid', 'invoice.payment_failed']);
    const options = { outDir: join(dir, '.workflow-test/contracts'), contractDir: dir, contractFile: file };

    const first = await materialize((await readContract(file)).contract, loadCatalog('stripe'), options);
    const snapshot = {
      contract: readFileSync(file, 'utf8'),
      schema: readFileSync(join(dir, first.shape?.schema ?? ''), 'utf8'),
      examples: readFileSync(join(dir, first.shape?.examples ?? ''), 'utf8'),
    };

    const second = await materialize((await readContract(file)).contract, loadCatalog('stripe'), options);
    expect(readFileSync(file, 'utf8')).toBe(snapshot.contract);
    expect(readFileSync(join(dir, second.shape?.schema ?? ''), 'utf8')).toBe(snapshot.schema);
    expect(readFileSync(join(dir, second.shape?.examples ?? ''), 'utf8')).toBe(snapshot.examples);
  });
});
