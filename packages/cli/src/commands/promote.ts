import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { loadSuites } from 'workflow-test-runner';
import { stringify } from 'yaml';
import { EXIT, parseArgs, type Io } from '../io.js';

/**
 * Copy a generated case into a hand-written test.
 *
 * A generated case asserts only what the oracle can infer. Promoting one is how
 * a user says "this variant matters, and here is specifically what should happen"
 * — so the copy carries the payload verbatim and leaves a `then:` skeleton to
 * fill in. The id is recorded in the contract's `.keep` file, because a case
 * someone has invested an expectation in should not silently disappear the next
 * time the generator's inputs change.
 */
export async function promoteCommand(argv: string[], io: Io): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const caseId = positional[0];
  if (caseId === undefined) {
    io.err('usage: workflow-test promote <caseId> [--name <file>]');
    return EXIT.usage;
  }

  const { generated } = await loadSuites(io.cwd);
  const found = generated
    .flatMap((suite) => suite.cases.map((entry) => ({ suite, entry })))
    .find(({ entry }) => entry.id === caseId);

  if (found === undefined) {
    io.err(`no generated case "${caseId}" in .workflow-test/cases — run \`workflow-test gen\` first, or check the id`);
    return EXIT.usage;
  }

  const name = typeof flags.name === 'string' && flags.name.length > 0 ? flags.name : `promoted-${caseId}`;
  const testsDir = join(io.cwd, '.workflow-test', 'tests');
  const outFile = join(testsDir, `${name}.test.yaml`);

  if (existsSync(outFile)) {
    io.err(`${relative(io.cwd, outFile)} already exists; pass --name to choose another`);
    return EXIT.usage;
  }

  // The suite's workflow path is relative to the cases directory; the promoted
  // test lives somewhere else, so it needs its own way back.
  const workflowFile = resolve(dirname(found.suite.file), found.suite.workflow);
  const workflow = relative(testsDir, workflowFile);

  const body = stringify({
    workflow,
    cases: [
      {
        id: found.entry.id,
        ...(found.entry.title === undefined ? {} : { title: found.entry.title }),
        when: found.entry.when,
      },
    ],
  }, { lineWidth: 0 });

  const file = [
    `# Promoted from a generated case by \`workflow-test promote ${caseId}\`.`,
    '#',
    '# The payload is the generated one, verbatim. Say what should happen to it:',
    '# expectations are flat, dotted keys.',
    '#',
    '#     then:',
    '#       execution.status: success',
    '#       node.<Name>.items: 1',
    '#       node.<Name>.output[0].json.<path>: <value>',
    '#',
    '# `workflow-test schema` prints the full format.',
    '',
    body,
  ].join('\n');

  await mkdir(testsDir, { recursive: true });
  await writeFile(outFile, file);

  // Keep the generated original from being retired out from under the promotion.
  const keepFile = join(dirname(found.suite.file), '.keep');
  const existing = existsSync(keepFile) ? await readFile(keepFile, 'utf8') : '';
  if (!existing.split('\n').includes(caseId)) {
    await appendFile(keepFile, `${caseId}\n`);
  }

  io.out(`created ${relative(io.cwd, outFile)}`);
  io.out(`kept ${caseId} in ${relative(io.cwd, keepFile)}`);
  io.out('');
  io.out('Add a `then:` block saying what should happen, then run `workflow-test run`.');
  return EXIT.ok;
}
