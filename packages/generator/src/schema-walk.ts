import AjvModule from 'ajv';
import { deleteAtPath, getAtPath, setAtPath } from './mutate.js';
import type { Mutation } from './types.js';

type Schema = Record<string, unknown>;

const isSchema = (v: unknown): v is Schema => v !== null && typeof v === 'object' && !Array.isArray(v);
const isRecord = isSchema;

export interface EnumerateOptions {
  /** Trigger-payload paths the workflow reads; variation concentrates here. */
  focus: Set<string>;
  overrides?: { required?: string[]; never?: string[] };
  /** Every example available, searched for a fragment matching a oneOf branch. */
  examples?: unknown[];
}

/** ajv v8 is CJS; its class arrives either bare or under `.default`. */
const Ajv = ((AjvModule as unknown as { default?: typeof AjvModule }).default ??
  AjvModule) as unknown as new (options: Record<string, unknown>) => {
  compile: (schema: object) => (data: unknown) => boolean;
};

const validator = new Ajv({ strict: false, allErrors: false, validateFormats: false });

const validates = (schema: unknown, value: unknown): boolean => {
  if (!isSchema(schema)) return false;
  try {
    return validator.compile(schema)(value);
  } catch {
    return false;
  }
};

const typesOf = (schema: Schema): string[] => {
  const type = schema.type;
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === 'string');
  return [];
};

/**
 * Build the smallest instance satisfying a schema.
 *
 * The one place synthesis is allowed, and only when no example covers a branch —
 * every such mutation is tagged `synthesized` so a failure it causes can be
 * weighed differently from one a real payload caused.
 */
function minimalInstance(schema: unknown, depth = 0): unknown {
  if (!isSchema(schema) || depth > 6) return null;
  const types = typesOf(schema);
  const enumeration = schema.enum;
  if (Array.isArray(enumeration) && enumeration.length > 0) return enumeration[0];

  if (types.includes('object') || isRecord(schema.properties)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const out: Record<string, unknown> = {};
    for (const key of required) {
      if (typeof key === 'string') out[key] = minimalInstance(properties[key], depth + 1);
    }
    return out;
  }
  if (types.includes('array')) return [minimalInstance(schema.items, depth + 1)];
  if (types.includes('number') || types.includes('integer')) return 1;
  if (types.includes('boolean')) return true;
  if (types.includes('null')) return null;
  return schema.format === 'date-time' ? '2026-01-01T00:00:00Z' : 'workflow-tester';
}

/** Edge values worth trying for a leaf, by declared type and format. */
function formatEdges(schema: Schema): Array<{ detail: string; value: unknown }> {
  const types = typesOf(schema);
  const edges: Array<{ detail: string; value: unknown }> = [];

  if (types.includes('string')) {
    edges.push({ detail: 'empty', value: '' });
    edges.push({ detail: 'unicode', value: 'ünïcode 🎉 表' });
    if (schema.format === 'date-time') {
      edges.push({ detail: 'epoch', value: '1970-01-01T00:00:00Z' });
      edges.push({ detail: 'far-future', value: '9999-12-31T23:59:59Z' });
    }
  }
  if (types.includes('number') || types.includes('integer')) {
    edges.push({ detail: 'zero', value: 0 });
    edges.push({ detail: 'negative', value: -1 });
    edges.push({ detail: 'max-safe', value: Number.MAX_SAFE_INTEGER });
  }
  return edges;
}

/**
 * Enumerate the changes worth making to an example payload.
 *
 * Mutations are always expressed against a real example rather than built from
 * the schema: a payload nobody has ever sent proves little, and a failure on one
 * is hard to trust. The single exception is a `oneOf` branch no example covers,
 * which is synthesised and tagged as such.
 */
export function enumerateMutations(
  schema: unknown,
  example: unknown,
  options: EnumerateOptions,
): Mutation[] {
  const mutations: Mutation[] = [];
  const never = options.overrides?.never ?? [];
  const forcedRequired = options.overrides?.required ?? [];
  const examples = options.examples ?? [example];

  const pruned = (path: string): boolean =>
    never.some((entry) => entry === path || path.startsWith(`${entry}.`) || path.startsWith(`${entry}[`));

  /** Does anything the workflow reads live at or below this path? */
  const inFocus = (path: string): boolean => {
    for (const focus of options.focus) {
      if (focus === path || focus.startsWith(`${path}.`) || focus.startsWith(`${path}[`)) return true;
    }
    return false;
  };

  const walk = (node: unknown, path: string): void => {
    if (!isSchema(node) || pruned(path)) return;

    const branches = node.oneOf ?? node.anyOf;
    if (Array.isArray(branches)) {
      const current = getAtPath(example, path)[0];
      branches.forEach((branch, index) => {
        // Prefer a fragment some real example already contains.
        let replacement: unknown;
        let synthesized = false;
        const fromExamples = examples
          .map((candidate) => getAtPath(candidate, path)[0])
          .find((fragment) => fragment !== undefined && validates(branch, fragment));

        if (fromExamples !== undefined) {
          replacement = fromExamples;
        } else {
          replacement = minimalInstance(branch);
          synthesized = true;
        }

        mutations.push({
          kind: 'oneOf-branch',
          path,
          detail: `branch ${index}`,
          ...(synthesized ? { synthesized: true } : {}),
          apply: (payload) => setAtPath(payload, path, replacement),
        });
      });

      // Keep walking the branch the example actually matches, so nested
      // properties still get their own mutations.
      const matching = branches.find((branch) => validates(branch, current));
      if (matching !== undefined) walk(matching, path);
      return;
    }

    const types = typesOf(node);

    if (types.includes('array') || node.items !== undefined) {
      const present = getAtPath(example, path)[0];
      if (Array.isArray(present)) {
        const first = present[0];
        for (const count of [0, 1, 3]) {
          if (count === present.length) continue;
          const value =
            count === 0
              ? []
              : Array.from({ length: count }, () =>
                  first === undefined ? minimalInstance(node.items) : structuredClone(first),
                );
          mutations.push({
            kind: 'array-cardinality',
            path,
            detail: String(count),
            apply: (payload) => setAtPath(payload, path, value),
          });
        }
      }
      if (inFocus(`${path}[]`) || inFocus(path)) walk(node.items, `${path}[]`);
      return;
    }

    if (!isRecord(node.properties)) return;
    const required = new Set(
      (Array.isArray(node.required) ? node.required : []).filter((k): k is string => typeof k === 'string'),
    );

    for (const [key, childSchema] of Object.entries(node.properties)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      if (pruned(childPath) || !isSchema(childSchema)) continue;

      const present = getAtPath(example, childPath).length > 0;
      const optional = !required.has(key) && !forcedRequired.includes(childPath);
      if (optional && present) {
        mutations.push({
          kind: 'optional-absent',
          path: childPath,
          detail: '',
          apply: (payload) => deleteAtPath(payload, childPath),
        });
      }

      // A subtree nothing reads is worth dropping wholesale, but not exploring:
      // varying a field no expression touches cannot change behaviour, and the
      // case set is the scarce resource. Non-focus paths get optional-absent and
      // nothing else.
      if (!inFocus(childPath)) continue;

      const childTypes = typesOf(childSchema);
      if (childTypes.includes('null') || childSchema.nullable === true) {
        mutations.push({
          kind: 'nullable-null',
          path: childPath,
          detail: '',
          apply: (payload) => setAtPath(payload, childPath, null),
        });
      }

      const enumeration = childSchema.enum;
      if (Array.isArray(enumeration)) {
        const current = getAtPath(example, childPath)[0];
        for (const member of enumeration) {
          if (member === current) continue;
          mutations.push({
            kind: 'enum-value',
            path: childPath,
            detail: String(member),
            apply: (payload) => setAtPath(payload, childPath, member),
          });
        }
      }

      if (enumeration === undefined && present) {
        for (const edge of formatEdges(childSchema)) {
          mutations.push({
            kind: 'format-edge',
            path: childPath,
            detail: edge.detail,
            apply: (payload) => setAtPath(payload, childPath, edge.value),
          });
        }
      }

      walk(childSchema, childPath);
    }
  };

  walk(schema, '');
  return mutations;
}
