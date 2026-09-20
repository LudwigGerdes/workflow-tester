import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { ContractError, readContract, wrapWebhook, wrapWebhookSchema } from 'payload-contract-contracts';
import { extractFocusPaths, generate, stableHash, type Case, type WorkflowJson } from 'payload-contract-generator';
import { walkWith } from 'payload-contract-engine';
import { shapeHasPath, shapeOfItems } from 'payload-contract-contracts';
import { EXIT, parseArgs, type Io } from '../io.js';
import { contractPathFor, findContracts } from './contracts.js';

/** Version stamped into each index, so a generator change shows as staleness. */
const GENERATOR_VERSION = '0.0.1';

interface TaggedExample {
  event?: string;
  payload: unknown;
}

interface CaseIndex {
  cases: Array<{ id: string; title: string; tags: string[] }>;
  stats: Record<string, number>;
  focus: string[];
  inputs: { workflow: string; contract: string; shape: string; generator: string };
  /**
   * What each Code node was observed to do to the data, as shape only.
   *
   * Committed so it is reviewable: the lineage of everything downstream rests
   * on it, and a reader should be able to see what was assumed rather than
   * infer it from a hash moving. Editing a Code node changes the workflow hash
   * and `gen --check` already fails; this is what makes the diff mean something.
   */
  codeShapes?: Record<string, { input: unknown; output: unknown }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The value a vendor sends in its event header for one event, as recorded on
 * the wrapped schema by `materialize`. Absent for vendors that discriminate in
 * the body instead.
 */
function headerValueFor(wrapped: unknown, event: string | undefined): string | undefined {
  if (event === undefined || !isRecord(wrapped)) return undefined;
  const branches = Array.isArray(wrapped.oneOf) ? wrapped.oneOf : [wrapped];
  for (const branch of branches) {
    if (!isRecord(branch) || branch['x-payload-contract-event'] !== event) continue;
    const properties = isRecord(branch.properties) ? branch.properties : {};
    const headers = isRecord(properties.headers) ? properties.headers : {};
    const headerProps = isRecord(headers.properties) ? headers.properties : {};
    for (const value of Object.values(headerProps)) {
      if (isRecord(value) && typeof value.const === 'string') return value.const;
    }
  }
  return undefined;
}

/** Generate the cases for one contract; returns its exit code. */
async function generateFor(
  contractFile: string,
  io: Io,
  options: { max?: number; check: boolean },
): Promise<number> {
  const { contract, dir } = await readContract(contractFile);

  if (contract.shape === undefined) {
    io.err(
      `${relative(io.cwd, contractFile)}: no materialised shape — run \`payload-contract contracts add\` or ` +
        '`payload-contract contracts update` first',
    );
    return EXIT.usage;
  }

  const workflowFile = contractFile.replace(/\.contract\.yaml$/, '.json');
  if (!existsSync(workflowFile)) {
    io.err(`${relative(io.cwd, contractFile)}: no workflow at ${relative(io.cwd, workflowFile)}`);
    return EXIT.usage;
  }

  const schemaFile = resolve(dir, contract.shape.schema);
  const examplesFile = resolve(dir, contract.shape.examples);
  for (const file of [schemaFile, examplesFile]) {
    if (!existsSync(file)) {
      io.err(`${relative(io.cwd, contractFile)}: missing shape file ${relative(io.cwd, file)}`);
      return EXIT.usage;
    }
  }

  const workflowText = await readFile(workflowFile, 'utf8');
  const contractText = await readFile(contractFile, 'utf8');
  const schemaText = await readFile(schemaFile, 'utf8');
  const workflow = JSON.parse(workflowText) as WorkflowJson;
  const schema = JSON.parse(schemaText) as unknown;
  const examples = JSON.parse(await readFile(examplesFile, 'utf8')) as TaggedExample[];

  // Expressions read `$json.body.…`, so generation happens at envelope level:
  // the schema is lifted and every example wrapped the way the Webhook node
  // delivers it. Focus paths and mutation paths then speak the same language.
  const vendor = contract.source.vendor;
  const wrappedSchema = wrapWebhookSchema(schema, { vendor });
  const wrappedExamples = examples.map((example) => ({
    event: example.event,
    payload: wrapWebhook(example.payload, {
      vendor,
      event: headerValueFor(wrappedSchema, example.event),
    }),
  }));

  // A Code node is arbitrary JavaScript, so what comes out of it can only be
  // learned by running it. One walk of the vendor's own example says which
  // fields survived, and a field that went in and came out again still traces
  // back to the trigger — which is what keeps everything downstream testable.
  const observed = await observeCodeNodes(workflow, contract.trigger, wrappedExamples[0]?.payload);
  const focus = extractFocusPaths(workflow, contract.trigger, {
    ...(observed === undefined ? {} : { survives: observed.survives }),
  });
  for (const name of observed?.unobserved ?? []) {
    io.out(`  note  ${name}: not reached by the example, so nothing after it is varied`);
  }
  const shapeBase = basename(contract.shape.schema).replace(/\.schema\.json$/, '');
  const workflowName = basename(workflowFile, '.json');
  const outDir = join(io.cwd, '.payload-contract', 'cases', workflowName, shapeBase);

  const { cases, stats } = generate({
    schema: wrappedSchema,
    examples: wrappedExamples,
    focus: new Set(focus.map((f) => f.path)),
    overrides: contract.overrides,
    max: options.max,
    // The budget follows the workflow's size unless --max says otherwise.
    nodeCount: workflow.nodes.length,
    contractKey: `${vendor}.${shapeBase}`,
  });

  const index: CaseIndex = {
    ...(observed === undefined || Object.keys(observed.shapes).length === 0
      ? {}
      : { codeShapes: observed.shapes }),
    cases: cases.map((c) => ({ id: c.id, title: c.title, tags: c.tags })),
    stats: { ...stats },
    focus: focus.map((f) => f.path),
    inputs: {
      workflow: stableHash(workflowText),
      contract: stableHash(contractText),
      shape: stableHash(schemaText),
      generator: GENERATOR_VERSION,
    },
  };

  const previous = await readIndex(outDir);
  const nextIds = new Set(cases.map((c) => c.id));
  const previousIds = new Set((previous?.cases ?? []).map((c) => c.id));
  const added = [...nextIds].filter((id) => !previousIds.has(id));
  const retired = [...previousIds].filter((id) => !nextIds.has(id));
  const unchanged = nextIds.size - added.length;
  const inputsMoved = JSON.stringify(previous?.inputs) !== JSON.stringify(index.inputs);
  const stale = added.length > 0 || retired.length > 0 || inputsMoved;

  const label = `${relative(io.cwd, workflowFile)} → ${shapeBase}`;

  if (options.check) {
    if (stale) {
      io.err(
        `${label}: cases are stale (${added.length} to add, ${retired.length} to retire) — run \`payload-contract gen\``,
      );
      return EXIT.findings;
    }
    io.out(`${label}: ${unchanged} case(s) unchanged`);
    return EXIT.ok;
  }

  await mkdir(outDir, { recursive: true });
  const keep = await readKeep(outDir);
  for (const id of retired) {
    if (keep.has(id)) continue;
    await rm(join(outDir, `${id}.json`), { force: true });
  }
  for (const entry of cases) {
    await writeFile(join(outDir, `${entry.id}.json`), `${JSON.stringify(entry, null, 2)}\n`);
  }
  await writeFile(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);

  // Say where the number came from: a count with no explanation invites either
  // suspicion or misplaced confidence.
  const budget =
    options.max === undefined
      ? `budget ${Math.round(3.5 * workflow.nodes.length)} for ${workflow.nodes.length} node${workflow.nodes.length === 1 ? '' : 's'}`
      : `max ${options.max}`;
  io.out(
    `${label}: ${cases.length} case(s) — ${added.length} added, ${retired.length} retired, ${unchanged} unchanged` +
      ` (${budget}${stats.truncated > 0 ? `, ${stats.truncated} discarded` : ''})`,
  );
  for (const path of index.focus.length === 0 ? ['(the workflow reads nothing off its trigger)'] : []) {
    io.out(`  warn  ${path}`);
  }
  return EXIT.ok;
}

async function readIndex(dir: string): Promise<CaseIndex | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as CaseIndex;
  } catch {
    return undefined;
  }
}

/** Ids listed in `.keep` survive regeneration even when retired. */
async function readKeep(dir: string): Promise<Set<string>> {
  try {
    const text = await readFile(join(dir, '.keep'), 'utf8');
    return new Set(text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0));
  } catch {
    return new Set();
  }
}

export async function genCommand(argv: string[], io: Io): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const max = typeof flags.max === 'string' ? Number(flags.max) : undefined;
  if (max !== undefined && !Number.isFinite(max)) {
    io.err(`--max expects a number, got "${String(flags.max)}"`);
    return EXIT.usage;
  }

  const targets =
    positional.length > 0
      ? positional.map((p) => contractPathFor(join(io.cwd, relative(io.cwd, p))))
      : await findContracts(io.cwd);

  if (targets.length === 0) {
    io.out('no contracts found');
    return EXIT.ok;
  }

  let worst: number = EXIT.ok;
  for (const contractFile of targets) {
    try {
      const code = await generateFor(contractFile, io, {
        max,
        // `gen` writes; `--check` is the read-only form for pre-commit and
        // CI. PAYLOAD_CONTRACT_MODE does not gate this command: a `gen` that refused
        // to write told people to run the command they had just run.
        check: flags.check === true,
      });
      if (code > worst) worst = code;
    } catch (error) {
      io.err(error instanceof ContractError ? error.message : String(error));
      worst = EXIT.usage;
    }
  }
  return worst;
}

/**
 * Run the example through the workflow and see what each Code node did to it.
 *
 * Returns a predicate saying whether a path went into a node and came out
 * again, plus the Code nodes the example never reached — those stay opaque, and
 * saying so is better than leaving a silent gap in what gets tested.
 */
async function observeCodeNodes(
  workflow: WorkflowJson,
  trigger: string,
  payload: unknown,
): Promise<
  | {
      survives: (node: string, path: string) => boolean;
      unobserved: string[];
      shapes: Record<string, { input: unknown; output: unknown }>;
    }
  | undefined
> {
  const codeNodes = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.code');
  if (codeNodes.length === 0 || payload === undefined) return undefined;

  const predecessorOf = (name: string): string | undefined => {
    for (const [from, connection] of Object.entries(workflow.connections)) {
      for (const outputs of connection.main ?? []) {
        for (const edge of outputs ?? []) if (edge.node === name) return from;
      }
    }
    return undefined;
  };

  let result;
  try {
    result = await walkWith({
      workflow: workflow as unknown as Parameters<typeof walkWith>[0]['workflow'],
      trigger,
      payload,
    });
  } catch {
    // The example did not survive the walk. Nothing observed, nothing claimed.
    return undefined;
  }

  const seen = new Map<string, { input: ReturnType<typeof shapeOfItems>; output: ReturnType<typeof shapeOfItems> }>();
  const unobserved: string[] = [];

  for (const node of codeNodes) {
    const output = result.outputs[node.name];
    const from = predecessorOf(node.name);
    const input = from === undefined ? undefined : result.outputs[from];
    if (output === undefined || input === undefined) {
      unobserved.push(node.name);
      continue;
    }
    seen.set(node.name, { input: shapeOfItems(input.flat()), output: shapeOfItems(output.flat()) });
  }

  return {
    survives: (node, path) => {
      const shapes = seen.get(node);
      return (
        shapes !== undefined && shapeHasPath(shapes.input, path) && shapeHasPath(shapes.output, path)
      );
    },
    unobserved,
    shapes: Object.fromEntries([...seen].sort(([a], [b]) => a.localeCompare(b))),
  };
}
