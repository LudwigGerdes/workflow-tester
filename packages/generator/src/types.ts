/** A payload path the workflow actually reads, and where it reads it. */
export interface FocusPath {
  /** Dotted, with `[]` for array elements, e.g. `body.data.object.customer_email`. */
  path: string;
  sources: Array<{ node: string; parameter: string; expression: string }>;
}

export type MutationKind =
  | 'optional-absent'
  | 'nullable-null'
  | 'oneOf-branch'
  | 'enum-value'
  | 'array-cardinality'
  | 'format-edge';

/** One change to make to an example payload. */
export interface Mutation {
  kind: MutationKind;
  path: string;
  /** What the change was: a branch index, an enum member, a cardinality. */
  detail: string;
  /** True when no example fragment existed and the value had to be built. */
  synthesized?: boolean;
  apply: (payload: unknown) => unknown;
}

/** A mutation as recorded in a case, without its function. */
export type MutationRecord = Omit<Mutation, 'apply'>;

export interface Case {
  id: string;
  title: string;
  tags: string[];
  event?: string;
  payload: unknown;
  provenance: {
    exampleIndex: number;
    mutations: MutationRecord[];
    seed?: string;
  };
}

export interface GenerateStats {
  examples: number;
  single: number;
  pairs: number;
  /** How many candidate cases the cap discarded. */
  truncated: number;
}
