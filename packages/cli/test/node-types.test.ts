import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { nodeTypesCommand } from '../src/commands/node-types.js';
import type { Io } from '../src/io.js';

/** A real Io, so the command is driven the way the CLI drives it. */
const sink = (env: Record<string, string | undefined> = {}) => {
  const lines: string[] = [];
  const io: Io = { cwd: process.cwd(), env, out: (l) => lines.push(l), err: (l) => lines.push(l) };
  return { lines, io };
};

/** One-entry tar, laid out the way a real tarball is. */
function tarWith(path: string, body: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write(`${Buffer.byteLength(body).toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  header.write('0', 156, 1, 'utf8');
  header.write('        ', 148, 8, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  const data = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
  data.write(body, 0, 'utf8');
  return Buffer.concat([header, data, Buffer.alloc(1024)]);
}

const DUMP = JSON.stringify([
  { name: 'set', version: 3.4, properties: [], inputs: ['main'], outputs: ['main'] },
  { name: 'slack', version: 1, properties: [], inputs: ['main'], outputs: ['main'] },
]);

describe('payload-contract node-types --version', () => {
  it('writes a version directory holding only what payload-contract reads', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'payload-contract-cache-'));
    const tar = gzipSync(tarWith('package/dist/types/nodes.json', DUMP));
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/n8n/2.38.3')) {
        return new Response(JSON.stringify({ dependencies: { 'n8n-nodes-base': '2.38.1' } }), { status: 200 });
      }
      if (url.includes('/n8n-nodes-base/2.38.1')) {
        return new Response(JSON.stringify({ dist: { tarball: 'https://registry.example/b.tgz' } }), { status: 200 });
      }
      return new Response(tar, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const { lines, io } = sink({ PAYLOAD_CONTRACT_CACHE: cache });
    const code = await nodeTypesCommand(['--version', '2.38.3'], io, fetchImpl);

    expect(code).toBe(0);
    const nodes = JSON.parse(
      readFileSync(join(cache, 'node-types', '2.38.3', 'nodes.json'), 'utf8'),
    ) as Array<{ name: string }>;
    expect(nodes.map((n) => n.name)).toEqual(['n8n-nodes-base.set']);
    const meta = JSON.parse(
      readFileSync(join(cache, 'node-types', '2.38.3', 'meta.json'), 'utf8'),
    ) as Record<string, string>;
    expect(meta['libraryVersion']).toBe('2.38.1');
    expect(lines.join('\n')).toMatch(/2\.38\.3/);
  });

  it('exits 2 and says so when the registry cannot be reached', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
    }) as unknown as typeof globalThis.fetch;
    const { lines, io } = sink();
    const code = await nodeTypesCommand(['--version', '2.38.3'], io, fetchImpl);
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/ENOTFOUND|could not/i);
  });
});

describe('payload-contract node-types --from', () => {
  it('reads hand-authored descriptions off disk, without the network', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'payload-contract-cache-'));
    const from = mkdtempSync(join(tmpdir(), 'payload-contract-from-'));
    // A custom type: the allowlist would discard it, and --from must not.
    writeFileSync(
      join(from, 'nodes.json'),
      JSON.stringify([{ name: '@acme/custom.thing', version: 1, properties: [] }]),
    );
    writeFileSync(join(from, 'meta.json'), JSON.stringify({ n8nVersion: '9.9.9' }));

    const { io } = sink({ PAYLOAD_CONTRACT_CACHE: cache });
    const explode = (() => {
      throw new Error('the network must not be touched by --from');
    }) as unknown as typeof globalThis.fetch;
    const code = await nodeTypesCommand(['--from', from], io, explode);

    expect(code).toBe(0);
    const written = JSON.parse(
      readFileSync(join(cache, 'node-types', '9.9.9', 'nodes.json'), 'utf8'),
    ) as Array<{ name: string }>;
    expect(written).toHaveLength(1);
    expect(written[0]?.name).toBe('@acme/custom.thing');
  });

  it('rejects a directory that is not a description source', async () => {
    const from = mkdtempSync(join(tmpdir(), 'payload-contract-from-'));
    mkdirSync(join(from, 'empty'), { recursive: true });
    const { lines, io } = sink();
    const code = await nodeTypesCommand(['--from', from], io);
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/nodes\.json/);
  });
});

describe('payload-contract node-types', () => {
  it('rejects an unknown flag rather than ignoring it', async () => {
    // A stub that throws, so a regression here fails loudly instead of
    // quietly reaching the network.
    const explode = (() => {
      throw new Error('no test may make a request');
    }) as unknown as typeof globalThis.fetch;
    const { lines, io } = sink();
    const code = await nodeTypesCommand(['--registry', 'https://x'], io, explode);
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/--registry/);
  });
});

describe('payload-contract node-types --instance', () => {
  it('detects the version, then extracts for it, with no api key', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'payload-contract-cache-'));
    const payload = Buffer.from(JSON.stringify({ release: 'n8n@2.38.3' })).toString('base64');
    const tar = gzipSync(tarWith('package/dist/types/nodes.json', DUMP));
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://n8n.example.invalid/') {
        return new Response(`<meta name="n8n:config:sentry" content="${payload}">`, { status: 200 });
      }
      if (url.includes('/n8n/2.38.3')) {
        return new Response(JSON.stringify({ dependencies: { 'n8n-nodes-base': '2.38.1' } }), { status: 200 });
      }
      if (url.includes('/n8n-nodes-base/2.38.1')) {
        return new Response(JSON.stringify({ dist: { tarball: 'https://registry.example/b.tgz' } }), { status: 200 });
      }
      return new Response(tar, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    // No N8N_API_KEY in the environment: detection must not need one.
    const { lines, io } = sink({ PAYLOAD_CONTRACT_CACHE: cache });
    const code = await nodeTypesCommand(['--instance', 'https://n8n.example.invalid'], io, fetchImpl);

    expect(code).toBe(0);
    expect(existsSync(join(cache, 'node-types', '2.38.3', 'nodes.json'))).toBe(true);
    expect(lines.join('\n')).toMatch(/2\.38\.3/);
  });

  it('asks for --version when detection fails', async () => {
    const fetchImpl = (async () => new Response('<html></html>', { status: 200 })) as unknown as typeof globalThis.fetch;
    const { lines, io } = sink();
    const code = await nodeTypesCommand(['--instance', 'https://n8n.example.invalid'], io, fetchImpl);
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/--version/);
  });

  it('still refuses two sources at once', async () => {
    const { lines, io } = sink();
    const code = await nodeTypesCommand(['--instance', 'https://x', '--version', '2.38.3'], io);
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/exactly one/);
  });
});

describe('payload-contract node-types --list', () => {
  it('names every extracted version and what run would choose', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'payload-contract-cache-'));
    mkdirSync(join(cache, 'node-types', '2.38.3'), { recursive: true });
    writeFileSync(
      join(cache, 'node-types', '2.38.3', 'meta.json'),
      JSON.stringify({ n8nVersion: '2.38.3', libraryVersion: '2.38.1' }),
    );
    writeFileSync(
      join(cache, 'node-types', '2.38.3', 'nodes.json'),
      JSON.stringify([{ name: 'set', version: 1, properties: [] }]),
    );

    const { lines, io } = sink({ PAYLOAD_CONTRACT_CACHE: cache });
    const code = await nodeTypesCommand(['--list'], io);

    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toMatch(/2\.38\.3/);
    expect(text).toMatch(/bundled/i);
    expect(text).toMatch(/2\.10\.0/);
  });

  it('works with nothing extracted at all', async () => {
    const { lines, io } = sink({ PAYLOAD_CONTRACT_CACHE: mkdtempSync(join(tmpdir(), 'payload-contract-empty-')) });
    expect(await nodeTypesCommand(['--list'], io)).toBe(0);
    expect(lines.join('\n')).toMatch(/bundled/i);
  });

  it('refuses --list combined with a source', async () => {
    const { lines, io } = sink();
    expect(await nodeTypesCommand(['--list', '--version', '2.38.3'], io)).toBe(2);
    expect(lines.join('\n')).toMatch(/--list/);
  });
});
