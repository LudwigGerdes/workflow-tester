/**
 * Reducing captured data to shape.
 *
 * A capture comes from a real execution, so it carries whatever actually flowed
 * through the workflow — customer records, API responses, whatever the node was
 * handling. None of that is written to disk. What is kept is the *shape*: which
 * fields exist and what type each holds.
 *
 * Shape is also the only portable part. The same workflow runs in dev and in
 * production against different data, so a fixture carrying dev's values would
 * assert things about records production never sees. Shape survives the trip.
 */

export type ShapeType = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object' | 'unknown';

export interface Shape {
  type: ShapeType;
  /** For objects: the shape of each key seen. */
  fields?: Record<string, Shape>;
  /** For arrays: the merged shape of the elements. */
  items?: Shape;
  /**
   * True when the field was absent from at least one observed item. Optional
   * fields are the ones that break downstream expressions intermittently, so
   * the distinction is worth keeping.
   */
  optional?: boolean;
  /**
   * For arrays: how many elements were observed, widened across every
   * occurrence. Absent on captures written before this was recorded, and a
   * reader treats absent as "unknown" rather than as zero.
   */
  cardinality?: { min: number; max: number };
}

/**
 * Assign a field without letting a hostile key rewrite the object.
 *
 * `JSON.parse` makes `__proto__` an own property and `Object.entries` hands it
 * over like any other key — but plain assignment invokes the `__proto__`
 * setter and replaces the target's prototype. After that, a lookup for an
 * inherited name reports a field that was never recorded, which is a wrong
 * answer from the part of the tool whose whole job is right answers.
 *
 * `defineProperty` creates an own data property instead, so the key survives as
 * data and the object keeps its prototype. workflow-test reads untrusted webhook
 * payloads, so this path is reachable by design rather than by accident.
 */
export const setOwn = <T>(target: Record<string, T>, key: string, value: T): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
};

const typeOf = (value: unknown): ShapeType => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      return 'unknown';
  }
};

/** The shape of one value. */
export function shapeOfValue(value: unknown): Shape {
  const type = typeOf(value);

  if (type === 'object') {
    const fields: Record<string, Shape> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      setOwn(fields, key, shapeOfValue(v));
    }
    return { type, fields };
  }

  if (type === 'array') {
    const entries = value as unknown[];
    const cardinality = { min: entries.length, max: entries.length };
    if (entries.length === 0) return { type, cardinality };
    return { type, cardinality, items: entries.map(shapeOfValue).reduce(mergeShape) };
  }

  return { type };
}

/**
 * Combine two shapes for the same position.
 *
 * Differing types widen to `unknown` rather than picking a winner: a field that
 * is sometimes a string and sometimes an object is precisely the case that
 * breaks a workflow, and recording only the first would hide it.
 */
export function mergeShape(a: Shape, b: Shape): Shape {
  if (a.type !== b.type) {
    // `null` alongside a real type means nullable, not a different shape.
    if (a.type === 'null') return { ...b, optional: true };
    if (b.type === 'null') return { ...a, optional: true };
    return { type: 'unknown', optional: a.optional === true || b.optional === true };
  }

  const merged: Shape = { type: a.type };
  if (a.optional === true || b.optional === true) merged.optional = true;

  if (a.type === 'object') {
    const fields: Record<string, Shape> = {};
    const keys = new Set([...Object.keys(a.fields ?? {}), ...Object.keys(b.fields ?? {})]);
    for (const key of keys) {
      const left = a.fields?.[key];
      const right = b.fields?.[key];
      if (left === undefined) setOwn(fields, key, { ...right!, optional: true });
      else if (right === undefined) setOwn(fields, key, { ...left, optional: true });
      else setOwn(fields, key, mergeShape(left, right));
    }
    merged.fields = fields;
  }

  if (a.type === 'array') {
    if (a.items !== undefined || b.items !== undefined) {
      merged.items =
        a.items === undefined
          ? b.items
          : b.items === undefined
            ? a.items
            : mergeShape(a.items, b.items);
    }
    const left = a.cardinality;
    const right = b.cardinality;
    if (left !== undefined && right !== undefined) {
      merged.cardinality = {
        min: Math.min(left.min, right.min),
        max: Math.max(left.max, right.max),
      };
    } else if (left !== undefined) merged.cardinality = left;
    else if (right !== undefined) merged.cardinality = right;
  }

  return merged;
}

/**
 * The shape of a node's whole output — every item merged, so a field missing
 * from one item is recorded as optional rather than silently assumed present.
 */
export function shapeOfItems(items: Array<{ json?: unknown }>): Shape {
  const shapes = items.map((item) => shapeOfValue(item.json ?? {}));
  if (shapes.length === 0) return { type: 'object', fields: {} };
  return shapes.reduce(mergeShape);
}

/** Every leaf path in a shape, as an expression would read them. */
export function pathsOf(shape: Shape, prefix = ''): string[] {
  if (shape.type === 'object' && shape.fields !== undefined) {
    return Object.entries(shape.fields).flatMap(([key, child]) =>
      pathsOf(child, prefix === '' ? key : `${prefix}.${key}`),
    );
  }
  return prefix === '' ? [] : [prefix];
}

export interface ShapeChange {
  path: string;
  kind: 'removed' | 'added' | 'type-changed' | 'now-optional';
  detail: string;
}

/**
 * What changed between a recorded shape and a fresh one.
 *
 * `removed` is the dangerous one: a field a later node reads that is no longer
 * produced resolves to undefined, which n8n swallows silently. The others are
 * reported so a person can see the workflow moved, and are not failures.
 */
export function diffShape(before: Shape, after: Shape, prefix = ''): ShapeChange[] {
  const changes: ShapeChange[] = [];
  const at = prefix === '' ? '(root)' : prefix;

  if (before.type !== after.type) {
    changes.push({
      path: at,
      kind: 'type-changed',
      detail: `was ${before.type}, now ${after.type}`,
    });
    return changes;
  }

  if (before.optional !== true && after.optional === true) {
    changes.push({ path: at, kind: 'now-optional', detail: 'no longer present on every item' });
  }

  if (before.type === 'object') {
    const keys = new Set([...Object.keys(before.fields ?? {}), ...Object.keys(after.fields ?? {})]);
    for (const key of [...keys].sort()) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      const left = before.fields?.[key];
      const right = after.fields?.[key];
      if (left !== undefined && right === undefined) {
        changes.push({ path, kind: 'removed', detail: `${left.type} is no longer produced` });
      } else if (left === undefined && right !== undefined) {
        changes.push({ path, kind: 'added', detail: `new ${right.type}` });
      } else if (left !== undefined && right !== undefined) {
        changes.push(...diffShape(left, right, path));
      }
    }
  }

  if (before.type === 'array' && before.items !== undefined && after.items !== undefined) {
    changes.push(...diffShape(before.items, after.items, `${at}[]`));
  }

  return changes;
}

/**
 * Is this path present in the shape?
 *
 * Paths are written the way the generator collapses them — `body.items[].sku`,
 * with `[]` for "each element" — so this walks fields and array elements the
 * same way. Used to ask whether a field that went into a node also came out.
 */
export function shapeHasPath(shape: Shape, path: string): boolean {
  let cursor: Shape | undefined = shape;

  for (const segment of path.split('.')) {
    if (segment === '') return false;
    const name = segment.replace(/(\[\])+$/, '');
    const depth = (segment.length - name.length) / 2;

    cursor = cursor?.type === 'object' ? cursor.fields?.[name] : undefined;
    if (cursor === undefined) return false;

    for (let i = 0; i < depth; i += 1) {
      cursor = cursor.type === 'array' ? cursor.items : undefined;
      if (cursor === undefined) return false;
    }
  }

  return true;
}
