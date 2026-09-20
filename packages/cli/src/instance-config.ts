import type { Io } from './io.js';

export interface InstanceConfig {
  url: string;
  key: string;
}

/**
 * Where the instance is and how to authenticate to it.
 *
 * The url can be given on the command line; the key never can. A key in argv
 * ends up in shell history and in the process list, so it comes from the
 * environment only — and it is never echoed back in an error, which is the
 * other easy way for a credential to reach a log.
 */
export function instanceConfig(
  io: Io,
  flags: Record<string, string | true>,
): InstanceConfig | { error: string } {
  const flagged = flags['instance'];
  if (flagged === true) return { error: 'payload-contract: --instance needs a url' };

  const url = flagged ?? io.env?.['N8N_API_URL'];
  if (url === undefined || url === '') {
    return { error: 'payload-contract: no instance url — pass --instance <url> or set N8N_API_URL' };
  }

  const key = io.env?.['N8N_API_KEY'];
  if (key === undefined || key === '') {
    return { error: 'payload-contract: no api key — set N8N_API_KEY' };
  }

  return { url, key };
}
