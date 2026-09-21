import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  FORMATS,
  loadSuites,
  renderReport,
  runTier1,
  testSchema,
  type ReportFormat,
  type RunReport,
} from 'workflow-tester-runner';
import { stringify } from 'yaml';
import { EXIT, parseArgs, type Io } from '../io.js';
import { configPath, readConfig } from '../config.js';

const REPORT_PATH = join('.workflow-tester', 'reports', 'last.json');

export async function runCommand(argv: string[], io: Io): Promise<number> {
  const { positional, flags } = parseArgs(argv);

  const format = (typeof flags.format === 'string' ? flags.format : 'stylish') as ReportFormat;
  if (!FORMATS.includes(format)) {
    io.err(`unknown --format "${format}" (expected ${FORMATS.join(', ')})`);
    return EXIT.usage;
  }

  const only = typeof flags.only === 'string' ? flags.only : undefined;
  if (only !== undefined && only !== 'generated' && only !== 'tests') {
    io.err(`unknown --only "${only}" (expected generated or tests)`);
    return EXIT.usage;
  }

  const failOn = typeof flags['fail-on'] === 'string' ? flags['fail-on'] : 'error';
  if (!['info', 'warn', 'error'].includes(failOn)) {
    io.err(`unknown --fail-on "${failOn}" (expected info, warn or error)`);
    return EXIT.usage;
  }

  const concurrency = typeof flags.concurrency === 'string' ? Number(flags.concurrency) : undefined;
  if (concurrency !== undefined && !Number.isFinite(concurrency)) {
    io.err(`--concurrency expects a number, got "${String(flags.concurrency)}"`);
    return EXIT.usage;
  }

  // A mistyped path used to run nothing and exit 0, which reads as a clean
  // run. The target has to be a workflow file that exists and parses.
  const target = positional[0];
  if (target !== undefined) {
    const file = resolve(io.cwd, target);
    if (!existsSync(file)) {
      io.err(`workflow-tester: no such workflow file: ${target}`);
      return EXIT.usage;
    }
    try {
      JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      io.err(`workflow-tester: ${target} is not a workflow JSON file (${error instanceof Error ? error.message : String(error)})`);
      return EXIT.usage;
    }
  }

  // The repository says which n8n release its workflows run on; absent, the
  // bundled descriptions are used and the report says so.
  const { n8nVersion } = readConfig(io);

  const report = await runTier1({
    dir: io.cwd,
    ...(only === undefined ? {} : { only }),
    ...(positional[0] === undefined ? {} : { workflow: positional[0] }),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(n8nVersion === undefined ? {} : { n8nVersion }),
  });

  // `root` is the repo the run was invoked against, which is what the workflow
  // paths in the report are relative to — not necessarily process.cwd().
  io.out(await renderReport(report, format, { root: io.cwd }));

  // `explain` reads this; it is gitignored, being a record of one run.
  await mkdir(join(io.cwd, '.workflow-tester', 'reports'), { recursive: true });
  await writeFile(join(io.cwd, REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`);

  if (report.summary.fail > 0) return EXIT.findings;
  if (failOn !== 'error' && report.summary.warn > 0) return EXIT.findings;
  return EXIT.ok;
}

export function schemaCommand(io: Io): number {
  io.out(JSON.stringify(testSchema(), null, 2));
  return EXIT.ok;
}

const EXAMPLE = `# A hand-written test. workflow-tester runs these exactly like generated cases,
# as far as the expression-pure part of the workflow reaches.
#
# \`workflow-tester schema\` prints the JSON Schema for this file — point an LLM at it and
# it can write more without guessing.
#
# Everything below is commented out on purpose. It names a workflow you have
# not written yet, and a scaffold that fails its own first run only teaches you
# to ignore red lines. Point \`workflow:\` at a real file, uncomment, and run.
#
# workflow: ../../workflows/your-workflow.json
#
# cases:
#   - id: happy-path
#     title: the payload the workflow was written for
#     when:
#       # A node name, or a kind: webhook, form, chat.
#       trigger: webhook
#       # Just the body: workflow-tester wraps it in the envelope a Webhook node
#       # delivers, so \`$json.body.…\` resolves the way your expressions are
#       # written.
#       payload:
#         record:
#           name: Ada
#     then:
#       # Expectations are flat, dotted keys. Set, IF, Code, Respond to Webhook
#       # and the other nodes the engine interprets are checked here; anything
#       # past an HTTP call or a credentialed node reports "needs a real
#       # execution" rather than passing or failing.
#       execution.status: success
#       node.Extract.items: 1
#       node.Extract.output[0].json.name: Ada
`;

const README = `# .workflow-tester

Everything workflow-tester keeps for this repo.

| Path | What it is | Commit it? |
|---|---|---|
| \`contracts/\` | Materialised vendor schemas and examples, pinned to a spec version | yes |
| \`cases/\` | Generated cases and their index | yes |
| \`tests/\` | Hand-written and LLM-written tests | yes |
| \`reports/\` | The last run's output | no — add to .gitignore |

Generated files are committed on purpose: a pull request should show exactly
which cases changed. \`workflow-tester gen --check\` fails when they are stale.
`;

export async function initCommand(io: Io, argv: string[] = []): Promise<number> {
  const { flags } = parseArgs(argv);
  const given = typeof flags['n8n-version'] === 'string' ? flags['n8n-version'] : undefined;
  // Checked before anything is written: scaffolding and then refusing would
  // leave a half-initialised directory behind.
  if (given !== undefined && !/^\d+\.\d+/.test(given)) {
    io.err(`workflow-tester: "${given}" is not an n8n version — try 2.38.3`);
    return EXIT.usage;
  }

  const testsDir = join(io.cwd, '.workflow-tester', 'tests');
  const example = join(testsDir, 'example.test.yaml');
  const readme = join(io.cwd, '.workflow-tester', 'README.md');

  for (const file of [example, readme]) {
    if (existsSync(file)) {
      io.err(`${file} already exists; init will not overwrite it`);
      return EXIT.usage;
    }
  }

  await mkdir(testsDir, { recursive: true });
  await writeFile(example, EXAMPLE);
  await writeFile(readme, README);

  io.out('created .workflow-tester/tests/example.test.yaml');
  io.out('created .workflow-tester/README.md');

  // Which n8n release these workflows run on. Skip is a real answer — the
  // descriptions bundled inside workflow-tester work — so this never blocks and never
  // insists. A prompt that hangs a script is worse than a prompt that is
  // never shown.
  const answer =
    given ??
    (flags['no-ask'] === true || process.stdin.isTTY !== true
      ? undefined
      : await ask('n8n version? (blank to skip) '));

  if (answer !== undefined && answer !== '' && /^\d+\.\d+/.test(answer)) {
    await writeFile(configPath(io.cwd), `n8nVersion: ${answer}\n`);
    io.out(`created .workflow-tester/config.yaml (n8n ${answer})`);
  } else {
    io.out('');
    io.out('No n8n version recorded, so workflow-tester uses the descriptions bundled inside it.');
    io.out('To match your instance: `workflow-tester node-types --instance <url>`, then put');
    io.out('`n8nVersion: <version>` in .workflow-tester/config.yaml.');
  }

  io.out('');
  io.out('Point it at a real workflow, then run `workflow-tester run`.');
  return EXIT.ok;
}

/** One line from a person, or nothing if anything goes wrong. */
async function ask(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } catch {
    return '';
  } finally {
    rl.close();
  }
}

/**
 * Print a case as a test file, plus what the last run made of it.
 *
 * The output is deliberately paste-ready: the loop this serves is read a
 * failure, narrow it into a written test, run again.
 */
export async function explainCommand(argv: string[], io: Io): Promise<number> {
  const [caseId] = argv;
  if (caseId === undefined) {
    io.err('usage: workflow-tester explain <caseId>');
    return EXIT.usage;
  }

  const reportFile = join(io.cwd, REPORT_PATH);
  if (!existsSync(reportFile)) {
    io.err('no report yet — run `workflow-tester run` first');
    return EXIT.usage;
  }
  const report = JSON.parse(await readFile(reportFile, 'utf8')) as RunReport;

  const { generated, tests } = await loadSuites(io.cwd);
  const found = [...generated, ...tests]
    .flatMap((suite) => suite.cases.map((entry) => ({ suite, entry })))
    .find(({ entry }) => entry.id === caseId);

  if (found === undefined) {
    io.err(`no case "${caseId}" in .workflow-tester (looked in generated cases and written tests)`);
    return EXIT.usage;
  }

  const outcome = report.outcomes.find((entry) => entry.caseId === caseId);

  io.out(`# ${found.suite.workflow}`);
  io.out(
    stringify({
      workflow: found.suite.workflow,
      cases: [
        {
          id: found.entry.id,
          ...(found.entry.title === undefined ? {} : { title: found.entry.title }),
          when: found.entry.when,
          ...(found.entry.then === undefined ? {} : { then: found.entry.then }),
        },
      ],
    }).trimEnd(),
  );

  if (outcome === undefined) {
    io.out('');
    io.out('# this case was not in the last run');
    return EXIT.ok;
  }

  io.out('');
  io.out(`# last run: status ${outcome.status} — ${outcome.message}`);
  if (outcome.node !== undefined) {
    io.out(`#   at ${[outcome.node, outcome.parameter].filter(Boolean).join(' → ')}`);
  }
  if (outcome.expression !== undefined) io.out(`#   expression: ${outcome.expression}`);
  if (outcome.resolvedPath !== undefined) io.out(`#   resolved:   ${outcome.resolvedPath}`);
  for (const assertion of outcome.assertions) {
    if (assertion.status === 'pass') continue;
    io.out(`#   ${assertion.status}: ${assertion.path} ${assertion.message ?? ''}`.trimEnd());
  }
  return EXIT.ok;
}
