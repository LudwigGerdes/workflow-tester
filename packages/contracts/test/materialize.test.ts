import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from 'workflow-tester-vendors';
import { beforeEach, describe, expect, it } from 'vitest';
import { materialize, materializeSchema } from '../src/materialize.js';
import { readContract } from '../src/read.js';
import type { Contract } from '../src/types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-tester-materialize-'));
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
      outDir: join(dir, '.workflow-tester/contracts'),
      contractDir: dir,
      contractFile: file,
    });

    expect(result.events).toEqual(['invoice.paid']);
    expect(result.specVersion).toBe('2026-08-26.dahlia');
    expect(result.shape?.schema).toMatch(/^\.workflow-tester\/contracts\/stripe\./);

    const schema = JSON.parse(readFileSync(join(dir, result.shape?.schema ?? ''), 'utf8')) as {
      properties: { type: { const: string } };
    };
    expect(schema.properties.type.const).toBe('invoice.paid');
  });

  it('combines several events into a oneOf with a discriminator per branch', async () => {
    const file = stripeContract(['invoice.paid', 'invoice.payment_failed']);
    const { contract } = await readContract(file);
    const result = await materialize(contract, loadCatalog('stripe'), {
      outDir: join(dir, '.workflow-tester/contracts'),
      contractDir: dir,
      contractFile: file,
    });

    const schema = JSON.parse(readFileSync(join(dir, result.shape?.schema ?? ''), 'utf8')) as {
      oneOf: Array<{ properties: { type: { const: string } }; 'x-workflow-tester-event': string }>;
    };
    expect(schema.oneOf).toHaveLength(2);
    expect(schema.oneOf.map((b) => b.properties.type.const)).toEqual([
      'invoice.paid',
      'invoice.payment_failed',
    ]);
    expect(schema.oneOf.map((b) => b['x-workflow-tester-event'])).toEqual([
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
      outDir: join(dir, '.workflow-tester/contracts'),
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
        outDir: join(dir, '.workflow-tester/contracts'),
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
      outDir: join(dir, '.workflow-tester/contracts'),
      contractDir: dir,
      contractFile: file,
    });
    expect(result.events).toEqual(['invoice.paid']);
  });

  it('writes the shape back into the contract without disturbing the rest', async () => {
    const file = stripeContract(['invoice.paid']);
    const { contract } = await readContract(file);
    await materialize(contract, loadCatalog('stripe'), {
      outDir: join(dir, '.workflow-tester/contracts'),
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
    const options = { outDir: join(dir, '.workflow-tester/contracts'), contractDir: dir, contractFile: file };

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

describe('materialize a schema source', () => {
  const SCHEMA = {
    type: 'object',
    properties: { id: { type: 'string' }, total: { type: 'number' } },
    required: ['id'],
  };

  const schemaContract = (extra: string[] = []): string =>
    writeContract(
      [
        'version: 1',
        'trigger: Webhook',
        'source:',
        '  kind: schema',
        '  schema: ./schemas/order-created.json',
        ...extra,
        '',
      ].join('\n'),
    );

  const materializeIt = async (file: string) => {
    const { contract } = await readContract(file);
    return materializeSchema(contract, {
      outDir: join(dir, '.workflow-tester/contracts'),
      contractDir: dir,
      contractFile: file,
    });
  };

  it('copies a local JSON Schema into the shape and names it after the file', async () => {
    mkdirSync(join(dir, 'schemas'), { recursive: true });
    writeFileSync(join(dir, 'schemas/order-created.json'), JSON.stringify(SCHEMA));
    const file = schemaContract();
    const result = await materializeIt(file);

    expect(result.events).toEqual(['order-created']);
    expect(result.specVersion).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(result.shape).toEqual({
      schema: '.workflow-tester/contracts/schema.order-created.schema.json',
      examples: '.workflow-tester/contracts/schema.order-created.examples.json',
    });
    const written = JSON.parse(readFileSync(join(dir, result.shape!.schema), 'utf8')) as Record<string, unknown>;
    expect(written['x-workflow-tester-event']).toBe('order-created');
    expect(written.properties).toEqual(SCHEMA.properties);
    expect(JSON.parse(readFileSync(join(dir, result.shape!.examples), 'utf8'))).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(/no example/);
    expect(readFileSync(file, 'utf8')).toContain('shape:');
  });

  it('takes examples from a directory of JSON files or one file holding a list', async () => {
    mkdirSync(join(dir, 'schemas/order-created.examples'), { recursive: true });
    writeFileSync(join(dir, 'schemas/order-created.json'), JSON.stringify(SCHEMA));
    writeFileSync(join(dir, 'schemas/order-created.examples/b.json'), JSON.stringify({ id: 'b', total: 2 }));
    writeFileSync(join(dir, 'schemas/order-created.examples/a.json'), JSON.stringify({ id: 'a' }));
    writeFileSync(join(dir, 'schemas/order-created.examples/notes.txt'), 'ignored');
    const file = schemaContract(['  examples: ./schemas/order-created.examples', '  name: order']);
    const result = await materializeIt(file);
    expect(result.events).toEqual(['order']);
    expect(JSON.parse(readFileSync(join(dir, result.shape!.examples), 'utf8'))).toEqual([
      { event: 'order', payload: { id: 'a' } },
      { event: 'order', payload: { id: 'b', total: 2 } },
    ]);
    expect(result.warnings).toEqual([]);

    writeFileSync(join(dir, 'schemas/list.json'), JSON.stringify([{ id: 'x' }, { id: 'y' }]));
    const listed = await materializeIt(schemaContract(['  examples: ./schemas/list.json']));
    expect(JSON.parse(readFileSync(join(dir, listed.shape!.examples), 'utf8'))).toHaveLength(2);
  });

  it('rejects an example the schema does not accept, naming the file and the path', async () => {
    mkdirSync(join(dir, 'schemas'), { recursive: true });
    writeFileSync(join(dir, 'schemas/order-created.json'), JSON.stringify(SCHEMA));
    writeFileSync(join(dir, 'schemas/bad.json'), JSON.stringify([{ total: 'three' }]));
    await expect(materializeIt(schemaContract(['  examples: ./schemas/bad.json']))).rejects.toThrow(
      /bad\.json\[0\].*id|bad\.json\[0\].*total/s,
    );
  });

  it('names a missing or invalid schema file', async () => {
    await expect(materializeIt(schemaContract())).rejects.toThrow(/order-created\.json/);
    mkdirSync(join(dir, 'schemas'), { recursive: true });
    writeFileSync(join(dir, 'schemas/order-created.json'), '{"type": "nonsense"}');
    await expect(materializeIt(schemaContract())).rejects.toThrow(/order-created\.json.*schema/s);
  });
});
