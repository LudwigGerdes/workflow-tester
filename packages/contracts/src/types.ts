/** A contract describes what a workflow's trigger can receive. */
export interface Contract {
  version: 1;
  /** Name of the trigger node the payload enters at. */
  trigger: string;
  source: ContractSource;
  /** Written by `materialize`; paths are relative to the contract file. */
  shape?: { schema: string; examples: string };
  overrides?: Overrides;
}

/** Where the shape comes from. Nothing downstream of `shape` knows which kind produced it. */
export type ContractSource = VendorSource | SchemaSource;

/** Events from a shipped vendor catalogue (GitHub, Stripe). */
export interface VendorSource {
  kind: 'vendor';
  vendor: string;
  events: string[];
  /** Pinned for reproducibility; defaults to the catalog's latest. */
  specVersion?: string;
}

/** A JSON Schema you own, with optional example payloads, for any webhook. */
export interface SchemaSource {
  kind: 'schema';
  /** Path to a JSON Schema file (`.json`, `.yaml` or `.yml`), relative to the contract. */
  schema: string;
  /**
   * Example payloads, relative to the contract: a directory of `.json` files
   * (one payload each), or one `.json` file holding a payload or a list of them.
   */
  examples?: string;
  /** The event name cases are tagged with. Defaults to the schema file's basename. */
  name?: string;
}

export interface Overrides {
  /** Paths never dropped, even when the schema says optional. */
  required?: string[];
  /** Subtrees to leave alone entirely. */
  never?: string[];
  /** Restrict generation to these events. */
  only?: string[];
}

/** A validation problem in a contract file, located in the source YAML. */
export interface ContractIssue {
  message: string;
  path: string;
  line?: number;
  column?: number;
}

export class ContractError extends Error {
  constructor(
    readonly file: string,
    readonly issues: ContractIssue[],
  ) {
    const where = (i: ContractIssue): string =>
      i.line === undefined ? `${i.path}` : `${i.path} (line ${i.line})`;
    super(`${file}\n${issues.map((i) => `  ${where(i)}: ${i.message}`).join('\n')}`);
    this.name = 'ContractError';
  }
}
