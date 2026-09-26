import { createRequire } from 'node:module';

/** The version in this package's own manifest, so `--version`, reports and captures cannot drift. */
export const { version: VERSION } = createRequire(import.meta.url)('../package.json') as {
  version: string;
};
