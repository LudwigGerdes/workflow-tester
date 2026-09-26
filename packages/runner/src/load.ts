import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative } from 'node:path';
import Ajv2020Module from 'ajv/dist/2020.js';
import { LineCounter, parseDocument, type Document } from 'yaml';
import { sidecarsUnder } from 'workflow-tester-contracts';
import { dataDir } from 'workflow-tester-paths';
import { SuiteError, type Suite, type SuiteCase, type SuiteIssue } from './types.js';

export * from './types.js';

const require = createRequire(import.meta.url);

/**
 * ajv's default export only understands draft-07; the test-file schema declares
 * draft 2020-12, so the 2020 build is what compiles it.
 * As elsewhere, ajv v8 is CJS and its class arrives either bare or under
 * `.default` depending on the loader.
 */
const Ajv = ((Ajv2020Module as unknown as { default?: typeof Ajv2020Module }).default ??
  Ajv2020Module) as unknown as new (options: Record<string, unknown>) => {
  compile: (schema: object) => ((data: unknown) => boolean) & {
    errors?: Array<{ instancePath?: string; message?: string; params?: Record<string, unknown> }> | null;
  };
};

let cachedSchema: Record<string, unknown> | undefined;

/**
 * The published test-file schema.
 *
 * workflow-tester owns this format. The schema lives at
 * this file becomes a vendored copy with a conformance test asserting the two
 * agree. Until then it is authored here — marked pending-owner-sync in
 * CONFORMANCE.md — so that an LLM writing a test has something exact to follow.
 */
export function testSchema(): Record<string, unknown> & { $id?: string; required?: string[] } {
  cachedSchema ??= JSON.parse(
    readFileSync(join(dataDir('schema'), 'workflow-tester.test.schema.json'), 'utf8'),
  ) as Record<string, unknown>;
  return cachedSchema;
}

const validate = new Ajv({ strict: false, allErrors: true }).compile(testSchema());

/** `given` keys the schema describes for tier 2 that no engine here honours yet. */
const UNSUPPORTED_GIVEN = ['snapshot', 'packs', 'seed', 'faults'] as const;

/**
 * Validate a suite object against the published schema, returning what is wrong
 * with it. Used by the tier-2 compiler on its own output: a suite that fails the
 * owner's schema is a bug, not something to hand over.
 */
export function validateSuiteObject(value: unknown): string[] {
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => {
    const extra = error.params?.additionalProperty;
    const where = error.instancePath === '' ? '(root)' : error.instancePath;
    return typeof extra === 'string'
      ? `${where}: unexpected key "${extra}"`
      : `${where}: ${error.message ?? 'is invalid'}`;
  });
}

/** Turn an ajv instance path into the keys `yaml` needs to locate a node. */
function pointerToPath(pointer: string): Array<string | number> {
  return pointer
    .split('/')
    .filter((part) => part.length > 0)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part.replace(/~1/g, '/').replace(/~0/g, '~')));
}

function locate(doc: Document, lines: LineCounter, path: Array<string | number>): Pick<SuiteIssue, 'line' | 'column'> {
  for (let depth = path.length; depth >= 0; depth -= 1) {
    const node: unknown = depth === 0 ? doc.contents : doc.getIn(path.slice(0, depth), true);
    const range = (node as { range?: [number, number, number] } | undefined)?.range;
    if (range !== undefined) {
      const { line, col } = lines.linePos(range[0]);
      return { line, column: col };
    }
  }
  return {};
}

/**
 * Read one written suite, validating it against the schema workflow-tester publishes and
 * normalising it the way the owner's `suite.cases.expected.json` says a loader
 * must: the single-case form becomes one case called `default`, and file-level
 * `given` defaults merge into every case with the case's own keys winning.
 */
export async function loadSuiteFile(file: string): Promise<Suite> {
  const suite = await readSuite(file);
  if (suite === undefined) {
    throw new SuiteError(file, [
      { path: '', message: 'declares no cases: the file is empty or entirely comments' },
    ]);
  }
  return suite;
}

async function readSuite(file: string): Promise<Suite | undefined> {
  const text = await readFile(file, 'utf8');
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines });

  if (doc.errors.length > 0) {
    throw new SuiteError(
      file,
      doc.errors.map((error) => {
        const { line, col } = lines.linePos(error.pos[0]);
        return { path: '', message: error.message, line, column: col };
      }),
    );
  }

  const value: unknown = doc.toJS();
  // Empty, or nothing but comments. That declares no suite, which is not a
  // mistake — `init` scaffolds exactly this, so that a new repository's first
  // run is clean rather than red for a workflow nobody has written yet.
  if (value === null || value === undefined) return undefined;

  if (!validate(value)) {
    const issues: SuiteIssue[] = (validate.errors ?? []).map((error) => {
      const pointer = error.instancePath ?? '';
      const extra = error.params?.additionalProperty;
      return {
        path: pointer === '' ? '(root)' : pointer,
        message:
          typeof extra === 'string'
            ? `unexpected key "${extra}"`
            : `${error.message ?? 'is invalid'}`,
        ...locate(doc, lines, pointerToPath(pointer)),
      };
    });
    throw new SuiteError(file, issues);
  }

  const raw = value as Record<string, unknown>;
  const fileGiven = (raw.given ?? {}) as Record<string, unknown>;

  // These keys describe a mock the tier-1 engine does not have. A case that
  // declares a fault and expects the workflow to cope would pass for the
  // wrong reason if the key were ignored, so the file is refused instead.
  const unsupported: SuiteIssue[] = [];
  const checkGiven = (given: unknown, path: Array<string | number>): void => {
    if (given === null || typeof given !== 'object') return;
    for (const key of UNSUPPORTED_GIVEN) {
      if (!(key in given)) continue;
      unsupported.push({
        path: `/${[...path, 'given', key].join('/')}`,
        message: `given.${key} is not supported in this version; the case would run as if it were absent. Remove it, or pin the node's items with given.pinData`,
        ...locate(doc, lines, [...path, 'given', key]),
      });
    }
  };
  checkGiven(raw.given, []);
  if (Array.isArray(raw.cases)) {
    raw.cases.forEach((entry: unknown, index) => {
      if (entry !== null && typeof entry === 'object') checkGiven((entry as { given?: unknown }).given, ['cases', index]);
    });
  }
  if (unsupported.length > 0) throw new SuiteError(file, unsupported);

  // The single-case form carries `when` at the top level and no `cases`.
  const declared = Array.isArray(raw.cases)
    ? (raw.cases as SuiteCase[])
    : [
        {
          id: 'default',
          ...(raw.title === undefined ? {} : { title: raw.title as string }),
          ...(raw.given === undefined ? {} : { given: fileGiven }),
          when: raw.when as SuiteCase['when'],
          ...(raw.then === undefined ? {} : { then: raw.then as SuiteCase['then'] }),
        },
      ];

  const cases: SuiteCase[] = declared.map((entry) => {
    const merged = { ...fileGiven, ...(entry.given ?? {}) };
    return {
      ...entry,
      ...(Object.keys(merged).length === 0 ? {} : { given: merged }),
    };
  });

  return {
    file,
    workflow: raw.workflow as string,
    ...(raw.instance === undefined ? {} : { instance: raw.instance as string }),
    ...(raw.generated === undefined ? {} : { generated: raw.generated as Record<string, unknown> }),
    cases,
    synthetic: false,
  };
}

const isSuite = (suite: Suite | undefined): suite is Suite => suite !== undefined;

/** Files ending `.test.yaml` in a directory, sorted. */
async function suiteFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.yaml'))
    .map((entry) => join(dir, entry.name))
    .sort();
}

/**
 * Wrap a directory of generated cases as a suite.
 *
 * Phase 4 writes real `.test.yaml` files for tier 2; until then the runner reads
 * `.workflow-tester/cases` directly, so generated and hand-written cases go through one
 * code path from the start.
 */
async function syntheticSuites(root: string): Promise<Suite[]> {
  const casesRoot = join(root, '.workflow-tester', 'cases');
  if (!existsSync(casesRoot)) return [];
  const suites: Suite[] = [];

  for (const workflowEntry of (await readdir(casesRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!workflowEntry.isDirectory()) continue;
    const workflowDir = join(casesRoot, workflowEntry.name);

    for (const contractEntry of (await readdir(workflowDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!contractEntry.isDirectory()) continue;
      const contractDir = join(workflowDir, contractEntry.name);

      const files = (await readdir(contractDir))
        .filter((name) => name.endsWith('.json') && name !== 'index.json')
        .sort();

      const cases: SuiteCase[] = [];
      for (const name of files) {
        const generated = JSON.parse(await readFile(join(contractDir, name), 'utf8')) as {
          id?: string;
          title?: string;
          payload?: unknown;
        };
        cases.push({
          id: generated.id ?? basename(name, '.json'),
          ...(generated.title === undefined ? {} : { title: generated.title }),
          when: { trigger: 'webhook', payload: generated.payload },
        });
      }
      if (cases.length === 0) continue;

      suites.push({
        // Anchored to the index file that lives in this directory, not to the
        // directory itself: the runner resolves a suite's workflow against
        // `dirname(file)`, and a directory would lose a level.
        file: join(contractDir, 'index.json'),
        // Cases live at .workflow-tester/cases/<workflow>/<contract>; the workflow is the
        // sibling of the repo root's `workflows` directory.
        workflow: relative(contractDir, join(root, 'workflows', `${workflowEntry.name}.json`)),
        cases,
        synthetic: true,
      });
    }
  }
  return suites;
}

/** Every suite in a repo: generated cases and hand-written tests alike. */
/**
 * Suites for workflows that carry a capture but no cases.
 *
 * A workflow someone captured and never wrote tests for used to be invisible to
 * `run`: suites came only from `.workflow-tester`, so a repo without that directory had
 * nothing to run and reported a clean bill of health over a workflow nothing had
 * looked at. These carry no cases — the runner derives one from the capture —
 * but they are what makes the workflow visible at all.
 */
async function capturedSuites(root: string): Promise<Suite[]> {
  const suites: Suite[] = [];
  for (const sidecar of sidecarsUnder(root)) {
    const parsed = parseDocument(readFileSync(sidecar, 'utf8')).toJS() as {
      capture?: unknown;
    } | null;
    if (parsed?.capture === undefined) continue;
    const workflow = `${basename(sidecar, '.contract.yaml')}.json`;
    if (!existsSync(join(dirname(sidecar), workflow))) continue;
    suites.push({ file: sidecar, workflow, cases: [], synthetic: true });
  }
  return suites;
}

export async function loadSuites(
  root: string,
): Promise<{ generated: Suite[]; tests: Suite[]; captured: Suite[] }> {
  const written = await suiteFiles(join(root, '.workflow-tester', 'generated'));
  const hand = await suiteFiles(join(root, '.workflow-tester', 'tests'));

  return {
    generated: [
      ...(await Promise.all(written.map(readSuite))).filter(isSuite),
      ...(await syntheticSuites(root)),
    ],
    tests: (await Promise.all(hand.map(readSuite))).filter(isSuite),
    captured: await capturedSuites(root),
  };
}
