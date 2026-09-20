import { describe, expect, it } from 'vitest';
import {
  compareSpecVersions,
  listVendors,
  loadCatalog,
  loadSources,
  latestSpecVersion,
  UnknownVendorError,
} from '../src/index.js';

describe('sources', () => {
  it('lists every vendor the suite knows about', () => {
    expect(listVendors().sort()).toEqual(['github', 'slack', 'stripe']);
  });

  it('records how each vendor publishes its webhooks', () => {
    const sources = loadSources();
    expect(sources.vendors.github?.kind).toBe('openapi-x-webhooks');
    expect(sources.vendors.stripe?.kind).toBe('stripe-events');
    expect(sources.vendors.slack?.kind).toBe('none');
  });
});

describe('loadCatalog', () => {
  it('loads GitHub webhook events with self-contained schemas', () => {
    const catalog = loadCatalog('github');
    expect(catalog.vendor).toBe('github');
    expect(catalog.specVersion).toBe('1.1.4');
    expect(Object.keys(catalog.events)).toEqual(expect.arrayContaining(['push', 'pull-request-opened']));
    // the curated set is a slice of everything GitHub publishes
    expect(catalog.availableEvents.length).toBeGreaterThan(200);
    expect(catalog.availableEvents).toContain('push');
  });

  it('leaves no unresolved reference anywhere in a catalog', () => {
    for (const vendor of ['github', 'stripe']) {
      const serialised = JSON.stringify(loadCatalog(vendor));
      expect(serialised).not.toContain('"$ref"');
    }
  });

  it('carries provenance that can be traced back to the fetched bytes', () => {
    const push = loadCatalog('github').events.push;
    expect(push?.provenance).toMatchObject({
      vendor: 'github',
      event: 'push',
      specVersion: '1.1.4',
      derived: false,
      eventHeaderValue: 'push',
    });
    expect(push?.provenance.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(push?.provenance.sourceUrl).toContain('github');
  });

  it('maps a compound event key back to the header value GitHub sends', () => {
    // the payload carries `action: opened`; the header says only `pull_request`
    expect(loadCatalog('github').events['pull-request-opened']?.provenance.eventHeaderValue).toBe(
      'pull_request',
    );
  });

  it('has a real example payload for every curated GitHub event', () => {
    // Spec §4 anchors every generated mutation to a payload someone actually
    // sent. GitHub's REST description links one on 6 of 270 operations, so the
    // examples come from octokit's published set instead.
    const catalog = loadCatalog('github');
    const missing = Object.entries(catalog.events)
      .filter(([, entry]) => entry.examples.length === 0)
      .map(([event]) => event);
    expect(missing).toEqual([]);
  });

  it('records where a separately published example came from', () => {
    const push = loadCatalog('github').events.push;
    expect(push?.provenance.examplesUrl).toContain('octokit/webhooks');
    expect(push?.examples[0]).toMatchObject({ commits: expect.any(Array) });
  });

  it('keeps the real example payloads a vendor publishes', () => {
    const catalog = loadCatalog('github');
    const ping = catalog.events.ping?.examples[0] as Record<string, unknown> | undefined;
    expect(ping).toBeDefined();
    expect(Object.keys(ping ?? {})).toEqual(expect.arrayContaining(['zen', 'hook_id', 'repository']));
  });

  it('narrows each Stripe event by its type discriminator', () => {
    const catalog = loadCatalog('stripe');
    const paid = catalog.events['invoice.paid']?.schema as {
      properties: { type: { const: string } };
    };
    expect(paid.properties.type.const).toBe('invoice.paid');
    // and says plainly what it could not narrow
    expect(catalog.events['invoice.paid']?.provenance.caveats?.[0]).toContain('data.object');
  });

  it('refuses a vendor that publishes nothing, naming the reason', () => {
    expect(() => loadCatalog('slack')).toThrow(UnknownVendorError);
    expect(() => loadCatalog('slack')).toThrow(/nothing machine-readable|no catalog/i);
  });

  it('refuses a vendor it has never heard of', () => {
    expect(() => loadCatalog('doesnotexist')).toThrow(UnknownVendorError);
  });
});

describe('latestSpecVersion', () => {
  it('reports the version on disk', () => {
    expect(latestSpecVersion('github')).toBe('1.1.4');
    expect(latestSpecVersion('stripe')).toBe('2026-08-26.dahlia');
  });

  it('orders semver-ish and date-ish versions by their numeric parts', () => {
    const sorted = ['1.1.4', '1.10.0', '1.2.0', '2026-08-26.dahlia', '2026-11-02.emerald'].sort(
      compareSpecVersions,
    );
    expect(sorted).toEqual(['1.1.4', '1.2.0', '1.10.0', '2026-08-26.dahlia', '2026-11-02.emerald']);
  });
});
