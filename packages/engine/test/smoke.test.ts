import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, SUPPORTED_N8N_VERSION } from '../src/index.js';

describe('engine package', () => {
  it('declares the pinned n8n version the suite agrees on', () => {
    expect(SUPPORTED_N8N_VERSION).toBe('2.10.0');
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
