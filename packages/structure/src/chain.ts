/**
 * An access chain, as an expression writes it.
 *
 * The generator reasons about arrays and normalises every index to `[]`,
 * because a path it cannot name is a path it cannot vary. The checker needs the
 * opposite: `[7]` against a five-element array is the whole finding. One parser
 * produces both — `toFocusSegments` is the generator's reading.
 */
export type ChainSegment =
  | { kind: 'field'; name: string }
  | { kind: 'index'; index: number };

export type Chain = ChainSegment[];

/**
 * Read the property chain following a root token such as `$json`.
 *
 * Returns nothing when the chain contains a key that cannot be known
 * statically — a computed index, a method call — or when it is empty.
 */
export function readChain(code: string, start: number): Chain | undefined {
  const chain: Chain = [];
  let i = start;

  for (;;) {
    if (code.startsWith('?.', i)) i += 2;
    else if (code[i] === '.') i += 1;
    else if (code[i] === '[') {
      const bracket = /^\[\s*(?:'([^']*)'|"([^"]*)"|(\d+))\s*\]/.exec(code.slice(i));
      if (bracket === null) return undefined; // computed key
      const [matched, single, double, index] = bracket;
      if (index !== undefined) chain.push({ kind: 'index', index: Number(index) });
      else chain.push({ kind: 'field', name: single ?? double ?? '' });
      i += matched.length;
      continue;
    } else break;

    const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(code.slice(i));
    if (identifier === null) break;
    i += identifier[0].length;
    // A call is a method, not data: `.toUpperCase()` ends the chain before it.
    if (code[i] === '(') break;
    chain.push({ kind: 'field', name: identifier[0] });
  }

  return chain.length === 0 ? undefined : chain;
}

/** A chain as a person reads it: `items[7].name`. */
export function renderChain(chain: Chain): string {
  let out = '';
  for (const segment of chain) {
    if (segment.kind === 'index') out += `[${segment.index}]`;
    else out += out === '' ? segment.name : `.${segment.name}`;
  }
  return out;
}

/**
 * The generator's reading: indices collapsed onto the array that holds them,
 * so `grid[17][5]` and `grid[0][0]` name the same path.
 *
 * Returns nothing for a chain that indexes before it has named anything, which
 * is a path the generator cannot vary.
 */
export function toFocusSegments(chain: Chain): string[] | undefined {
  const out: string[] = [];
  for (const segment of chain) {
    if (segment.kind === 'field') {
      out.push(segment.name);
      continue;
    }
    const last = out.length - 1;
    const tail = out[last];
    if (tail === undefined) return undefined;
    out[last] = `${tail}[]`;
  }
  return out.length === 0 ? undefined : out;
}
