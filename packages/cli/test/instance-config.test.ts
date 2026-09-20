import { describe, expect, it } from 'vitest';
import { instanceConfig } from '../src/instance-config.js';
import type { Io } from '../src/io.js';

const io = (env: Record<string, string | undefined>): Io => ({
  cwd: '/tmp',
  out: () => {},
  err: () => {},
  env,
});

describe('instanceConfig', () => {
  it('takes both from the environment', () => {
    expect(
      instanceConfig(io({ N8N_API_URL: 'https://n8n.example', N8N_API_KEY: 'k' }), {}),
    ).toEqual({ url: 'https://n8n.example', key: 'k' });
  });

  it('lets --instance override the environment url', () => {
    expect(
      instanceConfig(io({ N8N_API_URL: 'https://old.example', N8N_API_KEY: 'k' }), {
        instance: 'https://new.example',
      }),
    ).toEqual({ url: 'https://new.example', key: 'k' });
  });

  it('explains what is missing when there is no url', () => {
    const result = instanceConfig(io({ N8N_API_KEY: 'k' }), {});
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/N8N_API_URL|--instance/);
  });

  it('explains what is missing when there is no key', () => {
    const result = instanceConfig(io({ N8N_API_URL: 'https://n8n.example' }), {});
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/N8N_API_KEY/);
  });

  it('never puts the key in the error', () => {
    const result = instanceConfig(io({ N8N_API_KEY: 'secret-key' }), {});
    expect((result as { error: string }).error).not.toContain('secret-key');
  });

  it('rejects --instance given without a value', () => {
    const result = instanceConfig(io({ N8N_API_KEY: 'k' }), { instance: true });
    expect(result).toHaveProperty('error');
  });
});
