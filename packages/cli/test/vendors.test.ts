import { beforeEach, describe, expect, it } from 'vitest';
import { vendorsCommand } from '../src/commands/vendors.js';
import { EXIT, type Io } from '../src/io.js';

let out: string[];
let err: string[];
const io = (): Io => ({ cwd: process.cwd(), out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: {} }) as Io;

beforeEach(() => {
  out = [];
  err = [];
});

describe('vendors events', () => {
  it('lists the event names `contracts add --events` accepts, one per line', () => {
    expect(vendorsCommand(['events', 'github'], io())).toBe(EXIT.ok);
    expect(out).toContain('issues-opened');
    expect(out).toContain('pull-request-opened');
    expect(out.every((line) => !line.includes(' '))).toBe(true);
  });

  it('uses the vendor’s own names where the vendor has them', () => {
    vendorsCommand(['events', 'stripe'], io());
    expect(out).toContain('invoice.paid');
  });

  it('refuses an unknown vendor, naming the ones that exist', () => {
    expect(vendorsCommand(['events', 'acme'], io())).toBe(EXIT.usage);
    expect(err.join('\n')).toMatch(/no vendor "acme".*github.*stripe/s);
  });

  it('says so when a vendor publishes no catalogue', () => {
    expect(vendorsCommand(['events', 'slack'], io())).toBe(EXIT.ok);
    expect(out.join('\n')).toMatch(/slack publishes no event catalogue/);
  });

  it('needs a vendor', () => {
    expect(vendorsCommand(['events'], io())).toBe(EXIT.usage);
  });
});
