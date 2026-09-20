import type { AssignmentCollectionValue, IDataObject, INodeExecutionData } from 'n8n-workflow';
import type { Semantics, Warning } from '../types.js';

/** Coerce an assignment value to its declared type, the way Set v3 does. */
function coerce(value: unknown, type: string | undefined): unknown {
  if (value === undefined || value === null) return value;
  switch (type) {
    case 'number': {
      const n = Number(value);
      return Number.isNaN(n) ? value : n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return Boolean(value);
    case 'string':
      return typeof value === 'string' ? value : stringify(value);
    case 'array':
    case 'object':
      return typeof value === 'string' ? parseOr(value) : value;
    default:
      return value;
  }
}

const stringify = (value: unknown): string =>
  typeof value === 'object' ? JSON.stringify(value) : String(value);

/** Parse JSON, falling back to the raw value — a bad literal is not our error to raise. */
function parseOr(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** What an n8n item may hold under a key. */
type ItemValue = IDataObject[string];

/** Write `name` into `target`, nesting on dots unless dot notation is disabled. */
function assign(target: IDataObject, name: string, value: ItemValue, dotNotation: boolean): void {
  if (!dotNotation || !name.includes('.')) {
    target[name] = value;
    return;
  }
  const path = name.split('.');
  const leaf = path.pop() as string;
  let cursor = target;
  for (const segment of path) {
    const next = cursor[segment];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as IDataObject;
  }
  cursor[leaf] = value;
}

/**
 * Set / Edit Fields v3.x. In `raw` mode the item becomes `jsonOutput` wholesale;
 * otherwise assignments are applied over either an empty object or a copy of the
 * incoming item, depending on `includeOtherFields`.
 */
export const setSemantics: Semantics = (ctx, input) => {
  const warnings: Warning[] = [];
  const output: INodeExecutionData[] = input.map((item, index) => {
    const params = ctx.resolve(index);
    let json: IDataObject;

    if (params.mode === 'raw') {
      const raw = params.jsonOutput;
      const parsed = typeof raw === 'string' ? parseOr(raw) : raw;
      json = (parsed !== null && typeof parsed === 'object' ? parsed : {}) as IDataObject;
    } else {
      json = params.includeOtherFields === true ? { ...item.json } : {};
      const options = (params.options ?? {}) as { dotNotation?: boolean };
      const dotNotation = options.dotNotation !== false;
      const collection = params.assignments as AssignmentCollectionValue | undefined;

      for (const entry of collection?.assignments ?? []) {
        if (entry.value === undefined) {
          warnings.push({
            kind: 'optional-undefined',
            node: ctx.node.name,
            parameter: `assignments.${entry.name}`,
            message: `assignment "${entry.name}" resolved to undefined`,
            itemIndex: index,
          });
        }
        // An expression result is `unknown` by nature; this is the point where
        // it becomes item data, so it is typed as what an n8n item can hold.
        assign(json, entry.name, coerce(entry.value, entry.type) as ItemValue, dotNotation);
      }
    }

    return { json, pairedItem: { item: index } };
  });

  return { outputs: [output], warnings };
};
