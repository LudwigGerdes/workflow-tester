import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  RegistryError,
  fetchDescriptionDump,
  readTarEntry,
  resolveLibraryVersion,
} from '../src/registry.js';

/** Build a one-entry tar archive the way a real tarball is laid out. */
function tarWith(path: string, body: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'utf8');
  header.write('0000000\0', 108, 8, 'utf8');
  header.write('0000000\0', 116, 8, 'utf8');
  header.write(`${Buffer.byteLength(body).toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  header.write('00000000000\0', 136, 12, 'utf8');
  header.write('0', 156, 1, 'utf8');
  // The checksum field is spaces while the checksum itself is computed.
  header.write('        ', 148, 8, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');

  const data = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
  data.write(body, 0, 'utf8');
  return Buffer.concat([header, data, Buffer.alloc(1024)]);
}

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('readTarEntry', () => {
  it('finds an entry by path', () => {
    const tar = tarWith('package/dist/types/nodes.json', '[{"name":"set"}]');
    expect(readTarEntry(tar, 'package/dist/types/nodes.json')?.toString('utf8')).toBe('[{"name":"set"}]');
  });

  it('returns undefined for a path that is not there', () => {
    expect(readTarEntry(tarWith('package/other.json', '{}'), 'package/dist/types/nodes.json')).toBeUndefined();
  });
});

describe('resolveLibraryVersion', () => {
  it('reads the library version out of the app version dependencies', async () => {
    // The whole point: n8n@2.38.3 depends on n8n-nodes-base@2.38.1.
    const fetch = (async () =>
      jsonResponse({ dependencies: { 'n8n-nodes-base': '2.38.1', 'n8n-workflow': '2.38.1' } })) as typeof globalThis.fetch;
    expect(await resolveLibraryVersion('2.38.3', fetch)).toBe('2.38.1');
  });

  it('fails clearly when the registry has no such n8n version', async () => {
    const fetch = (async () => new Response('Not Found', { status: 404 })) as typeof globalThis.fetch;
    await expect(resolveLibraryVersion('99.0.0', fetch)).rejects.toThrow(RegistryError);
    await expect(resolveLibraryVersion('99.0.0', fetch)).rejects.toThrow(/99\.0\.0/);
  });

  it('fails clearly when the dependency is absent', async () => {
    const fetch = (async () => jsonResponse({ dependencies: {} })) as typeof globalThis.fetch;
    await expect(resolveLibraryVersion('2.38.3', fetch)).rejects.toThrow(/n8n-nodes-base/);
  });
});

describe('fetchDescriptionDump', () => {
  it('pulls the description array out of the tarball', async () => {
    const tar = gzipSync(tarWith('package/dist/types/nodes.json', '[{"name":"set"},{"name":"if"}]'));
    const fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/n8n-nodes-base/2.38.1')) {
        return jsonResponse({ dist: { tarball: 'https://registry.example/base.tgz' } });
      }
      return new Response(tar, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const dump = await fetchDescriptionDump('2.38.1', fetch);
    expect(dump).toHaveLength(2);
  });

  it('fails clearly when the tarball has no description dump', async () => {
    const tar = gzipSync(tarWith('package/readme.md', 'hello'));
    const fetch = (async (input: RequestInfo | URL) =>
      String(input).endsWith('/n8n-nodes-base/2.38.1')
        ? jsonResponse({ dist: { tarball: 'https://registry.example/base.tgz' } })
        : new Response(tar, { status: 200 })) as unknown as typeof globalThis.fetch;

    await expect(fetchDescriptionDump('2.38.1', fetch)).rejects.toThrow(/dist\/types\/nodes\.json/);
  });
});
