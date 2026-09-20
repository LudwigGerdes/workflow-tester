import type { IDataObject } from 'n8n-workflow';

const isObject = (v: unknown): v is IDataObject =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Read a field, honouring dot notation unless the node disables it. */
export function getField(json: IDataObject, name: string, dotNotation = true): unknown {
  if (!dotNotation || !name.includes('.')) return json[name];
  let cursor: unknown = json;
  for (const segment of name.split('.')) {
    if (!isObject(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/** Write a field, honouring dot notation unless the node disables it. */
export function setField(json: IDataObject, name: string, value: unknown, dotNotation = true): void {
  if (!dotNotation || !name.includes('.')) {
    json[name] = value as IDataObject[string];
    return;
  }
  const path = name.split('.');
  const leaf = path.pop() as string;
  let cursor: IDataObject = json;
  for (const segment of path) {
    const next = cursor[segment];
    if (!isObject(next)) cursor[segment] = {};
    cursor = cursor[segment] as IDataObject;
  }
  cursor[leaf] = value as IDataObject[string];
}

/** Split a comma-separated field list as the editor's fields inputs accept it. */
export const fieldList = (value: unknown): string[] =>
  typeof value !== 'string'
    ? []
    : value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);

/** Stable key for equality comparison of a subset of an item's fields. */
export const keyOf = (value: unknown): string => {
  const canonical = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(canonical);
    if (!isObject(node)) return node;
    return Object.fromEntries(
      Object.entries(node)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  };
  return JSON.stringify(canonical(value));
};
