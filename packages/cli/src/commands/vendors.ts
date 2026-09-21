import { catalogVersions, listVendors, loadCatalog, readAudit, vendorSource } from 'workflow-tester-vendors';
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

  if (verb === 'events') {
    const vendor = argv[1];
    if (vendor === undefined) {
      io.err('workflow-tester vendors events: name a vendor, e.g. `workflow-tester vendors events github`');
      return EXIT.usage;
    }
    if (!listVendors().includes(vendor)) {
      io.err(`workflow-tester vendors events: no vendor "${vendor}" (known: ${listVendors().join(', ')})`);
      return EXIT.usage;
    }
    if (catalogVersions(vendor).length === 0) {
      io.out(`${vendor} publishes no event catalogue; write tests for it by hand`);
      return EXIT.ok;
    }
    // One name per line and nothing else, so the output pipes into grep or a shell loop.
    for (const event of Object.keys(loadCatalog(vendor).events).sort()) io.out(event);
    return EXIT.ok;
  }

  io.err(`workflow-tester vendors: unknown subcommand "${String(verb)}" (expected list, events or audit)`);
  return EXIT.usage;
}
