/** How a vendor publishes its webhook definitions. */
export type VendorKind =
  | 'openapi-webhooks' // OpenAPI 3.1 top-level `webhooks`
  | 'openapi-x-webhooks' // the `x-webhooks` vendor extension (GitHub)
  | 'openapi-callbacks' // OpenAPI 3.0 `callbacks`
  | 'stripe-events' // one envelope schema + an enumerated event list
  | 'examples-only' // published example payloads; schema derived from them
  | 'none'; // nothing machine-readable published

export interface VendorSource {
  kind: VendorKind;
  specUrl?: string;
  examplesUrl?: string[];
  versionFrom?: string;
  /** Header carrying the event name when the vendor puts it there (GitHub). */
  eventHeader?: string;
  /** Stripe: the schema every event is wrapped in. */
  envelopeSchema?: string;
  /** Stripe: dotted path to the enum listing event names. */
  eventEnumPath?: string;
  /**
   * Base URL for per-event example payloads, when a vendor publishes them apart
   * from its spec. Paths are derived from each operation's operationId.
   */
  examplesBaseUrl?: string;
  /** Curated allowlist of events to materialise into the catalog. */
  events?: string[];
  notes?: string;
}

export interface Sources {
  version: 1;
  vendors: Record<string, VendorSource>;
}

export interface Provenance {
  vendor: string;
  event: string;
  specVersion: string;
  sourceUrl: string;
  /** sha256 of the raw spec bytes the entry was derived from. */
  sha256: string;
  /** True when the schema was inferred from examples rather than published. */
  derived: boolean;
  /** The value a vendor sends in its event header, when it uses one. */
  eventHeaderValue?: string;
  /** The spec's operation id, which locates a separately published example. */
  operationId?: string;
  /** Where a separately published example payload came from. */
  examplesUrl?: string;
  /** Anything lossy about this entry, e.g. Stripe's untyped `data.object`. */
  caveats?: string[];
}

export interface CatalogEvent {
  /** Self-contained JSON Schema: every `$ref` resolved, nothing remote. */
  schema: unknown;
  examples: unknown[];
  provenance: Provenance;
}

export interface Catalog {
  vendor: string;
  specVersion: string;
  generatedAt: string;
  kind: VendorKind;
  /** Every event the source publishes, not just the materialised ones. */
  availableEvents: string[];
  events: Record<string, CatalogEvent>;
  /** Examples that failed validation against their own schema, kept as notes. */
  exampleWarnings: string[];
}
