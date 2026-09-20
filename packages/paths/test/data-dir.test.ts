import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dataDir } from '../src/index.js';

const only = (...paths: string[]) => (path: string) => paths.includes(path);

describe('dataDir', () => {
  it('reads the committed data in a checkout', () => {
    expect(existsSync(join(dataDir('node-types'), '2.10.0'))).toBe(true);
    expect(existsSync(join(dataDir('vendors'), 'sources.yaml'))).toBe(true);
    expect(existsSync(join(dataDir('vendors'), 'data', 'github'))).toBe(true);
    expect(existsSync(join(dataDir('schema'), 'payload-contract.test.schema.json'))).toBe(true);
  });

  it('resolves the same checkout data from the bundled CLI in packages/cli/dist', () => {
    const exists = only('/repo/packages/vendors/sources.yaml', '/repo/packages/engine/bundled');
    const layout = { here: '/repo/packages/cli/dist', env: {}, exists };
    expect(dataDir('node-types', layout)).toBe('/repo/packages/engine/bundled');
    expect(dataDir('vendors', layout)).toBe('/repo/packages/vendors');
    expect(dataDir('schema', layout)).toBe('/repo/packages/runner/schema');
  });

  it('reads <package>/data/<kind> when installed', () => {
    const layout = { here: '/app/node_modules/payload-contract/dist', env: {}, exists: () => false };
    expect(dataDir('node-types', layout)).toBe('/app/node_modules/payload-contract/data/node-types');
    expect(dataDir('vendors', layout)).toBe('/app/node_modules/payload-contract/data/vendors');
    expect(dataDir('schema', layout)).toBe('/app/node_modules/payload-contract/data/schema');
  });

  it('is not fooled by a neighbouring package that happens to be called engine', () => {
    const exists = only('/app/node_modules/engine/bundled');
    const layout = { here: '/app/node_modules/payload-contract/dist', env: {}, exists };
    expect(dataDir('vendors', layout)).toBe('/app/node_modules/payload-contract/data/vendors');
  });

  it('lets PAYLOAD_CONTRACT_DATA override both', () => {
    const layout = { here: '/repo/packages/cli/dist', env: { PAYLOAD_CONTRACT_DATA: '/mine' }, exists: () => true };
    expect(dataDir('schema', layout)).toBe('/mine/schema');
  });
});
