/** Everything a command touches outside itself, so tests can drive it. */
export interface Io {
  cwd: string;
  /**
   * The environment, passed in rather than read from `process.env` so a test
   * can set it and so a developer's own exported value cannot leak into the
   * suite. Absent means empty, which resolves to the default mode.
   */
  env?: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** 0 clean, 1 findings or failures, 2 usage or configuration error. */
export const EXIT = { ok: 0, findings: 1, usage: 2 } as const;

/** Parse `--flag value` and `--flag` into a map, keeping positional args. */
export function parseArgs(argv: string[]): {
  positional: string[];
  flags: Record<string, string | true>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}
