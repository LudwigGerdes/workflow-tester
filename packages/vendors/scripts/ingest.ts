/**
 * `pnpm ingest [--vendor <name>] [--refetch] [--offline]`
 *
 * Thin wrapper over `src/ingest.ts`, which holds the actual logic so that
 * `workflow-tester contracts update --fetch` can reach it too.
 */
import { ingestAll } from '../src/ingest.js';

const argv = process.argv.slice(2);
const vendorFlag = argv.indexOf('--vendor');

await ingestAll(vendorFlag === -1 ? undefined : argv[vendorFlag + 1], {
  refetch: argv.includes('--refetch'),
  offline: argv.includes('--offline'),
});
process.stdout.write('\nAUDIT.md regenerated\n');
