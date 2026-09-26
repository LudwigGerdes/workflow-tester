import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import {
  FORMATS,
  loadSuites,
  needsLive,
  renderReport,
  resolveTrigger,
  runOffline,
  runLive,
  testSchema,
  type Outcome,
  type ReportFormat,
  type RunReport,
  type LiveJob,
} from 'workflow-tester-runner';
import { createMockAdmin, createWorkflowRunner, type MockAdmin, type WorkflowRunner } from 'workflow-tester-instance';
import { stringify } from 'yaml';
import { EXIT, parseArgs, type Io } from '../io.js';
import { configPath, readConfig } from '../config.js';
import { instanceConfig } from '../instance-config.js';
import { VERSION } from '../version.js';

const REPORT_PATH = join('.workflow-tester', 'reports', 'last.json');

/** The clients a live run talks to; injectable so the command is testable without a network. */
export interface RunDeps {
  mock?: MockAdmin;
  runner?: WorkflowRunner;
}

const DEFAULT_MOCK_ADMIN = 'http://127.0.0.1:8081';

export async function runCommand(argv: string[], io: Io, deps: RunDeps = {}): Promise<number> {
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

  // A live run needs an instance to run on and a mock to run against. Both are
  // resolved before anything runs, so a missing key fails the command, not
  // the fifth case.
  const live = flags['live'] === true;
  let liveDeps: { mock: MockAdmin; runner: WorkflowRunner } | undefined;
  if (live) {
    const config = instanceConfig(io, flags);
    if ('error' in config) {
      io.err(`${config.error} (--live runs cases on your instance)`);
      return EXIT.usage;
    }
    const mockUrl = typeof flags['mock'] === 'string' ? flags['mock'] : (io.env?.['INTEGRATION_MOCK_ADMIN'] ?? DEFAULT_MOCK_ADMIN);
    const token = io.env?.['INTEGRATION_MOCK_ADMIN_TOKEN'];
    liveDeps = {
      mock: deps.mock ?? createMockAdmin({ url: mockUrl, ...(token === undefined ? {} : { token }) }),
      runner: deps.runner ?? createWorkflowRunner(config),
    };
  }

  // The repository says which n8n release its workflows run on; absent, the
  // bundled descriptions are used and the report says so.
  const { n8nVersion, testsDirs } = readConfig(io);

  const offline = await runOffline({
    dir: io.cwd,
    ...(testsDirs === undefined ? {} : { testsDirs }),
    ...(only === undefined ? {} : { only }),
    ...(positional[0] === undefined ? {} : { workflow: positional[0] }),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(n8nVersion === undefined ? {} : { n8nVersion }),
    ...(live ? { liveCases: 'skip' as const } : {}),
  });

  const report = liveDeps === undefined ? offline : await withLive(offline, liveDeps, io, { testsDirs, workflow: positional[0] });

  // `root` is the repo the run was invoked against, which is what the workflow
  // paths in the report are relative to — not necessarily process.cwd().
  io.out(await renderReport(report, format, { root: io.cwd, version: VERSION }));

  // `explain` reads this; it is gitignored, being a record of one run.
  await mkdir(join(io.cwd, '.workflow-tester', 'reports'), { recursive: true });
  await writeFile(join(io.cwd, REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`);

  if (report.summary.fail > 0) return EXIT.findings;
  if (failOn !== 'error' && report.summary.warn > 0) return EXIT.findings;
  return EXIT.ok;
}

/** Run the cases the offline walk left out on the instance against the mock, and fold them into the report. */
async function withLive(
  offline: RunReport,
  deps: { mock: MockAdmin; runner: WorkflowRunner },
  io: Io,
  filter: { testsDirs?: string[]; workflow?: string },
): Promise<RunReport> {
  const { tests } = await loadSuites(io.cwd, { ...(filter.testsDirs === undefined ? {} : { testsDirs: filter.testsDirs }) });
  const jobs: LiveJob[] = [];
  const failed: Outcome[] = [];
  for (const suite of tests) {
    if (filter.workflow !== undefined && !suite.workflow.includes(filter.workflow)) continue;
    const workflowFile = resolve(dirname(suite.file), suite.workflow);
    const shownAs = relative(io.cwd, workflowFile);
    const cases = suite.cases.filter(needsLive);
    if (cases.length === 0) continue;
    if (!existsSync(workflowFile)) {
      for (const entry of cases) failed.push({ caseId: entry.id, workflow: shownAs, status: 'fail', mode: 'live', message: `workflow not found: ${suite.workflow}`, assertions: [] });
      continue;
    }
    const workflow = JSON.parse(await readFile(workflowFile, 'utf8')) as { nodes?: Array<{ name: string; type: string }> };
    for (const entry of cases) {
      const declared = entry.when.trigger;
      const named = typeof declared === 'string' ? declared : declared?.node;
      const trigger = resolveTrigger(workflow.nodes ?? [], named);
      if (trigger === undefined) {
        failed.push({ caseId: entry.id, workflow: shownAs, status: 'fail', mode: 'live', message: named === undefined ? 'this workflow has no single trigger; name one in `when.trigger`' : `no trigger matching "${named}"`, assertions: [] });
        continue;
      }
      const payload = entry.when.payload ?? (typeof declared === 'object' && declared !== null ? declared.payload : undefined);
      jobs.push({ entry, shownAs, workflow, trigger, payload });
    }
  }
  const ran = await runLive(jobs, { mock: deps.mock, instance: deps.runner });
  const outcomes = [...offline.outcomes, ...failed, ...ran].sort((a, b) => a.caseId.localeCompare(b.caseId) || (a.node ?? '').localeCompare(b.node ?? ''));
  return {
    ...offline,
    outcomes,
    summary: {
      ...offline.summary,
      pass: outcomes.filter((o) => o.status === 'pass').length,
      fail: outcomes.filter((o) => o.status === 'fail').length,
      warn: outcomes.filter((o) => o.status === 'warn').length,
      needsExecution: outcomes.filter((o) => o.status === 'needs-execution').length,
      durationMs: offline.summary.durationMs + ran.reduce((sum, o) => sum + (o.durationMs ?? 0), 0),
    },
  };
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

  const { testsDirs: dirs } = readConfig(io);
  const { generated, tests } = await loadSuites(io.cwd, { ...(dirs === undefined ? {} : { testsDirs: dirs }) });
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
