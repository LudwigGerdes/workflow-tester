import { catalogVersions, listVendors, loadCatalog, readAudit, vendorSource } from 'payload-contract-vendors';
import { EXIT, type Io } from '../io.js';

export function vendorsCommand(argv: string[], io: Io): number {
  const [verb] = argv;

  if (verb === 'list') {
    io.out('vendor    coverage       spec version          events');
    for (const vendor of listVendors()) {
      const source = vendorSource(vendor);
      const kind = source?.kind ?? 'unknown';
      const coverage = kind === 'none' ? 'nothing' : kind === 'examples-only' ? 'examples only' : 'schema';
      const version = catalogVersions(vendor).at(-1);
      const events =
        version === undefined ? '—' : `${Object.keys(loadCatalog(vendor).events).length} of ${loadCatalog(vendor).availableEvents.length}`;
      io.out(
        `${vendor.padEnd(9)} ${coverage.padEnd(14)} ${(version ?? '—').padEnd(21)} ${events}`,
      );
    }
    return EXIT.ok;
  }

  if (verb === 'audit') {
    io.out(readAudit());
    return EXIT.ok;
  }

  io.err(`payload-contract vendors: unknown subcommand "${String(verb)}" (expected list or audit)`);
  return EXIT.usage;
}
