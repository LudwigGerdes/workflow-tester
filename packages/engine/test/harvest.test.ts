import { describe, expect, it } from 'vitest';
import { harvest, NEEDED_TYPES } from '../src/node-types/harvest.js';

/** Shaped like a real entry, including the fields that must be dropped. */
const entry = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  displayName: name,
  name,
  group: ['transform'],
  version: 1,
  subtitle: 'sub',
  description: 'a description',
  defaults: { name },
  usableAsTool: true,
  inputs: ['main'],
  outputs: ['main'],
  credentials: [{ name: 'someApi' }],
  properties: [{ displayName: 'Field', name: 'field', type: 'string', default: '' }],
  codex: { categories: ['x'] },
  iconUrl: 'icon.svg',
  ...extra,
});

describe('harvest', () => {
  it('keeps the types workflow-test reads and drops the rest', () => {
    const out = harvest([entry('set'), entry('slack'), entry('if'), entry('googleSheets')]);
    expect(out.map((n) => n.name).sort()).toEqual(['n8n-nodes-base.if', 'n8n-nodes-base.set']);
  });

  it('keeps every version entry of a type, not just the first', () => {
    // Set really does ship twice: [3, 3.1, …] and [1, 2]. Dropping one would
    // silently describe v2 workflows with v3 parameters.
    const out = harvest([entry('set', { version: [3, 3.4] }), entry('set', { version: [1, 2] })]);
    expect(out).toHaveLength(2);
    expect(out.map((n) => n.version)).toEqual([[3, 3.4], [1, 2]]);
  });

  it('drops the fields nothing reads', () => {
    const [out] = harvest([entry('set')]);
    expect(out).toBeDefined();
    for (const dropped of ['codex', 'iconUrl', 'credentials', 'subtitle', 'usableAsTool']) {
      expect(out).not.toHaveProperty(dropped);
    }
  });

  it('keeps the fields the engine reads', () => {
    const [out] = harvest([entry('set')]);
    for (const kept of ['name', 'version', 'inputs', 'outputs', 'properties', 'displayName', 'defaults', 'group']) {
      expect(out).toHaveProperty(kept);
    }
  });

  it('qualifies the bare name n8n publishes, and leaves a qualified one alone', () => {
    // A description carries its own name, and consumers read it. Aliasing only
    // the lookup key would leave `set` where `n8n-nodes-base.set` is expected.
    expect(harvest([entry('set')])[0]?.name).toBe('n8n-nodes-base.set');
    expect(harvest([entry('n8n-nodes-base.set')])[0]?.name).toBe('n8n-nodes-base.set');
  });

  it('keeps every entry when asked, so a custom node survives --from', () => {
    // The allowlist would discard a custom type, which is exactly what --from
    // is for. Filtering is for n8n's own dump, not for a hand-authored file.
    expect(harvest([entry('@n8n/custom.thing')])).toHaveLength(0);
    expect(harvest([entry('@n8n/custom.thing')], { all: true })[0]?.name).toBe('@n8n/custom.thing');
  });

  it('ignores malformed entries rather than throwing', () => {
    expect(harvest([null, 42, 'set', {}, entry('set')])).toHaveLength(1);
  });

  it('covers every node kind the engine interprets', () => {
    // The allowlist is derived from the semantics registry, so adding a
    // semantics without extracting its description cannot happen silently.
    for (const type of ['set', 'if', 'code', 'merge', 'switch', 'splitOut', 'stopAndError']) {
      expect(NEEDED_TYPES).toContain(type);
    }
  });

  it('includes the trigger and boundary types the corpus uses', () => {
    for (const type of ['webhook', 'manualTrigger', 'httpRequest', 'splitInBatches']) {
      expect(NEEDED_TYPES).toContain(type);
    }
  });
});
