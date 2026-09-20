import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RegistryError, detectVersion, fetchInstanceVersion } from '../src/registry.js';

const fixture = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'n8n-root.html'),
  'utf8',
);

describe('detectVersion', () => {
  it('reads the release out of n8n own config meta tag', () => {
    expect(detectVersion(fixture)).toBe('2.38.3');
  });

  it('strips the package prefix, leaving a bare version', () => {
    expect(detectVersion(fixture)).not.toMatch(/n8n@/);
  });

  it('returns undefined when the tag is absent, rather than guessing', () => {
    expect(detectVersion('<html><head></head><body></body></html>')).toBeUndefined();
  });

  it('returns undefined when the payload is not base64 json', () => {
    expect(
      detectVersion('<meta name="n8n:config:sentry" content="!!!not-base64!!!" />'),
    ).toBeUndefined();
  });

  it('returns undefined when the json carries no release', () => {
    const payload = Buffer.from(JSON.stringify({ environment: 'production' })).toString('base64');
    expect(detectVersion(`<meta name="n8n:config:sentry" content="${payload}" />`)).toBeUndefined();
  });

  it('tolerates single quotes and attribute order', () => {
    const payload = Buffer.from(JSON.stringify({ release: 'n8n@1.2.3' })).toString('base64');
    expect(detectVersion(`<meta content='${payload}' name='n8n:config:sentry'>`)).toBe('1.2.3');
  });
});

describe('fetchInstanceVersion', () => {
  const serving = (body: string, status = 200) => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(body, { status });
    }) as unknown as typeof globalThis.fetch;
    return { seen, fetchImpl };
  };

  it('asks the instance root page and returns the version', async () => {
    const { seen, fetchImpl } = serving(fixture);
    expect(await fetchInstanceVersion('https://n8n.example.invalid', fetchImpl)).toBe('2.38.3');
    // The root page, not an api path: detection needs no credential.
    expect(seen[0]).toBe('https://n8n.example.invalid/');
    expect(seen[0]).not.toMatch(/api|rest/);
  });

  it('tolerates a trailing slash on the url', async () => {
    const { seen, fetchImpl } = serving(fixture);
    await fetchInstanceVersion('https://n8n.example.invalid/', fetchImpl);
    expect(seen[0]).toBe('https://n8n.example.invalid/');
  });

  it('asks for an explicit version when the tag is absent, and never guesses', async () => {
    const { fetchImpl } = serving('<html></html>');
    await expect(fetchInstanceVersion('https://n8n.example.invalid', fetchImpl)).rejects.toThrow(
      /--version/,
    );
  });

  it('says so when the instance cannot be reached', async () => {
    const { fetchImpl } = serving('nope', 502);
    await expect(fetchInstanceVersion('https://n8n.example.invalid', fetchImpl)).rejects.toThrow(
      RegistryError,
    );
  });
});
