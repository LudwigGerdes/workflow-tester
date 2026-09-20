import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ContractError, readContract } from '../src/index.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}.contract.yaml`, import.meta.url));

const issuesOf = async (name: string) =>
  await readContract(fixture(name)).then(
    () => {
      throw new Error('expected readContract to reject');
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(ContractError);
      return (error as ContractError).issues;
    },
  );

describe('readContract', () => {
  it('reads a well-formed contract', async () => {
    const { contract, dir } = await readContract(fixture('valid'));
    expect(contract.version).toBe(1);
    expect(contract.trigger).toBe('Webhook');
    expect(contract.source).toEqual({
      kind: 'vendor',
      vendor: 'stripe',
      events: ['invoice.paid', 'invoice.payment_failed'],
      specVersion: '2026-08-26.dahlia',
    });
    expect(contract.overrides?.required).toEqual(['data.object.customer_email']);
    expect(dir).toMatch(/fixtures$/);
  });

  it('rejects an empty event list', async () => {
    const issues = await issuesOf('no-events');
    expect(issues[0]?.path).toBe('source.events');
    expect(issues[0]?.message).toMatch(/at least one/i);
  });

  it('rejects a source kind that is not vendor, listing what is allowed', async () => {
    const issues = await issuesOf('bad-kind');
    expect(issues[0]?.path).toBe('source.kind');
    expect(issues[0]?.message).toContain('vendor');
  });

  it('rejects malformed override paths', async () => {
    const issues = await issuesOf('bad-override');
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.path)).toEqual(['overrides.never[0]', 'overrides.never[1]']);
  });

  it('locates each issue in the source YAML', async () => {
    const issues = await issuesOf('bad-kind');
    // `kind: recorded` is on line 4 of the fixture
    expect(issues[0]?.line).toBe(4);
  });

  it('reports a missing file as a contract error, not a raw ENOENT', async () => {
    await expect(readContract(fixture('nope'))).rejects.toBeInstanceOf(ContractError);
  });
});
