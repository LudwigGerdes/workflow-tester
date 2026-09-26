import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { RunReport } from '../run.js';
import type { Outcome } from '../oracle.js';

export interface RenderOptions {
  /** Directory the workflow paths in the report are relative to. */
  root?: string;
  /** The workflow-tester release that produced the report; the CLI passes its own. */
  version?: string;
}

const HELP_URI = 'https://workflowtools.dev/workflow-tester/writing-tests';
const REPO_URI = 'https://github.com/LudwigGerdes/workflow-tester';

/** Seconds with millisecond precision, the way JUnit consumers read `time`. */
const seconds = (ms: number | undefined): string => ((ms ?? 0) / 1000).toFixed(3);

/** ISO end time from a start and a duration; absent when the report has no start. */
const endedAt = (report: RunReport): string | undefined =>
  report.startedAt === undefined
    ? undefined
    : new Date(Date.parse(report.startedAt) + Math.round(report.summary.durationMs)).toISOString();

export type ReportFormat = 'stylish' | 'json' | 'junit' | 'sarif' | 'github-actions';

export const FORMATS: ReportFormat[] = ['stylish', 'json', 'junit', 'sarif', 'github-actions'];

const SYMBOL: Record<Outcome['status'], string> = {
  pass: '✓',
  fail: '✗',
  warn: '!',
  'needs-execution': '·',
};

/** Group outcomes by the workflow they ran against, in a stable order. */
function byWorkflow(outcomes: Outcome[]): Array<[string, Outcome[]]> {
  const groups = new Map<string, Outcome[]>();
  for (const outcome of outcomes) {
    const key = outcome.workflow ?? '(unknown workflow)';
    groups.set(key, [...(groups.get(key) ?? []), outcome]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

const escapeXml = (value: string): string =>
  value.replace(/[<>&"']/g, (c) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', '"': 'quot', "'": 'apos' }[c] as string};`);

function stylish(report: RunReport): string {
  const lines: string[] = [];

  for (const [workflow, outcomes] of byWorkflow(report.outcomes)) {
    lines.push(workflow);
    for (const outcome of outcomes) {
      // A passing case needs one line; a failing one needs its reasons.
      const label = outcome.title ?? outcome.caseId;
      lines.push(`  ${SYMBOL[outcome.status]} ${label}${outcome.status === 'pass' ? '' : `  ${outcome.message}`}`);

      if (outcome.status === 'pass') continue;
      if (outcome.node !== undefined) {
        const where = [outcome.node, outcome.parameter].filter(Boolean).join(' → ');
        lines.push(`      at ${where}`);
      }
      if (outcome.expression !== undefined) lines.push(`      expression: ${outcome.expression}`);
      if (outcome.resolvedPath !== undefined) lines.push(`      resolved:   ${outcome.resolvedPath}`);
      for (const assertion of outcome.assertions) {
        if (assertion.status === 'pass') continue;
        const detail =
          assertion.status === 'needs-execution'
            ? (assertion.message ?? 'needs a real execution')
            : `expected ${JSON.stringify(assertion.expected)}, got ${JSON.stringify(assertion.actual)}`;
        lines.push(`      ${SYMBOL[assertion.status]} ${assertion.path}: ${detail}`);
      }
      // What the structural check found: a field read that the payload never
      // carries, an index past every observed length. It is why a case whose
      // expectations all held is still marked `!`, so it has to be visible
      // here and not only in the JSON report.
      for (const finding of outcome.structure ?? []) {
        const where = [finding.node, finding.parameter].filter(Boolean).join(' → ');
        lines.push(`      ${SYMBOL[finding.severity]} ${finding.message}  at ${where}`);
      }
    }
    lines.push('');
  }

  const { pass, fail, warn, needsExecution, durationMs } = report.summary;
  lines.push(`${pass} passed, ${fail} failed, ${warn} warned in ${Math.round(durationMs)}ms`);
  if (needsExecution > 0) {
    lines.push(`needs a real execution: ${needsExecution}`);
  }

  // Say what was not actually run. A green result that silently rested on
  // stand-ins claims more than it verified.
  const stood = [...new Set(report.outcomes.flatMap((o) => o.substituted ?? []))].sort();
  if (stood.length > 0) {
    lines.push(
      `stood in for ${stood.length} node${stood.length === 1 ? '' : 's'} from pinData or a recorded capture: ${stood.join(', ')}`,
    );
    lines.push('  their own behaviour is unverified; what reads them downstream is not');
  }

  // A missing required parameter is only a warning when the descriptions are
  // for another release, so say which release they were.
  if (report.nodeTypes !== undefined && !report.nodeTypes.exact) {
    lines.push('');
    lines.push(
      `note: ${report.nodeTypes.note ?? `node descriptions are for n8n ${report.nodeTypes.version}`}`,
    );
    lines.push('      `workflow-tester node-types --version <yours>` to match your instance');
  }
  return lines.join('\n');
}

function junit(report: RunReport, options: RenderOptions): string {
  const counts = (outcomes: Outcome[]) => ({
    tests: outcomes.length,
    failures: outcomes.filter((o) => o.status === 'fail').length,
    skipped: outcomes.filter((o) => o.status === 'needs-execution').length,
  });

  const testcase = (outcome: Outcome, classname: string): string => {
    const name = escapeXml(outcome.title ?? outcome.caseId);
    const open = `    <testcase name="${name}" classname="${classname}" time="${seconds(outcome.durationMs)}">`;
    if (outcome.status === 'pass') return `${open.slice(0, -1)}/>`;
    if (outcome.status === 'needs-execution') {
      return `${open}\n      <skipped message="${escapeXml(outcome.message)}"/>\n    </testcase>`;
    }
    const tag = outcome.status === 'fail' ? 'failure' : 'system-out';
    return `${open}\n      <${tag} message="${escapeXml(outcome.message)}"/>\n    </testcase>`;
  };

  // Which release judged these cases, and against which node descriptions:
  // a warning that would have been a failure on the right version is only
  // auditable if the report names both.
  const properties = [
    ...(options.version === undefined ? [] : [['workflow-tester.version', options.version]]),
    ...(report.nodeTypes === undefined
      ? []
      : [
          ['n8nVersion', report.nodeTypes.version],
          ['nodeTypes.version', report.nodeTypes.version],
          ['exact', String(report.nodeTypes.exact)],
        ]),
  ];
  const propertiesXml =
    properties.length === 0
      ? []
      : [
          '  <properties>',
          ...properties.map(([k, v]) => `    <property name="${escapeXml(k ?? '')}" value="${escapeXml(v ?? '')}"/>`),
          '  </properties>',
        ];

  const suites = byWorkflow(report.outcomes).flatMap(([workflow, outcomes]) => {
    const classname = escapeXml(workflow);
    const { tests, failures, skipped } = counts(outcomes);
    const time = seconds(outcomes.reduce((sum, o) => sum + (o.durationMs ?? 0), 0));
    return [
      `  <testsuite name="${classname}" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${time}">`,
      ...outcomes.map((outcome) => testcase(outcome, classname)),
      '  </testsuite>',
    ];
  });

  const { tests, failures, skipped } = counts(report.outcomes);
  const timestamp = report.startedAt === undefined ? '' : ` timestamp="${escapeXml(report.startedAt)}"`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="workflow-tester" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${seconds(report.summary.durationMs)}"${timestamp}>`,
    ...propertiesXml,
    ...suites,
    '</testsuites>',
  ].join('\n');
}

/**
 * The line on which the workflow JSON names a node, or nothing.
 *
 * n8n writes exports with one property per line, so `"name": "<node>"` is a
 * dependable anchor; anything else (a minified file, a name that appears
 * nowhere) leaves the result at file level rather than pointing at a guess.
 */
function lineOfNode(file: string, node: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const needle = `"name": ${JSON.stringify(node)}`;
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line.includes(needle));
  return index === -1 ? undefined : index + 1;
}

const SARIF_RULES = [
  {
    id: 'workflow-tester/case-failed',
    name: 'CaseFailed',
    shortDescription: { text: 'A test case failed: an expectation did not hold or an expression could not be evaluated.' },
    helpUri: HELP_URI,
    defaultConfiguration: { level: 'error' },
  },
  {
    id: 'workflow-tester/case-warned',
    name: 'CaseWarned',
    shortDescription: { text: 'A test case warned: every expectation held, but the run found something worth reading.' },
    helpUri: HELP_URI,
    defaultConfiguration: { level: 'warning' },
  },
];

/** Stable across runs for the same workflow, case and node, so a viewer can match results up. */
const fingerprint = (outcome: Outcome): string =>
  createHash('sha256')
    .update(`${outcome.workflow ?? ''}\0${outcome.caseId}\0${outcome.node ?? ''}`)
    .digest('hex');

async function sarif(report: RunReport, options: RenderOptions): Promise<string> {
  const root = options.root ?? process.cwd();

  const results = report.outcomes
    .filter((outcome) => outcome.status === 'fail' || outcome.status === 'warn')
    .map((outcome) => {
      const uri = outcome.workflow ?? 'workflow.json';
      // SARIF wants a repo-relative URI, but the file has to be opened from
      // here to find a line. Passing the relative path to both would make line
      // mapping fail silently and look like it worked.
      const readable = isAbsolute(uri) ? uri : resolve(root, uri);
      const line = outcome.node === undefined ? undefined : lineOfNode(readable, outcome.node);
      return {
        ruleId: `workflow-tester/${outcome.status === 'fail' ? 'case-failed' : 'case-warned'}`,
        level: outcome.status === 'fail' ? 'error' : 'warning',
        message: { text: `${outcome.title ?? outcome.caseId}: ${outcome.message}` },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri },
              // File-level unless the node's line was found: a region that
              // pointed somewhere plausible but wrong is worse than none.
              ...(line === undefined ? {} : { region: { startLine: line } }),
            },
            ...(outcome.node === undefined
              ? {}
              : { logicalLocations: [{ name: outcome.node, kind: 'node' }] }),
          },
        ],
        partialFingerprints: { 'workflow-tester/v1': fingerprint(outcome) },
      };
    });

  const ended = endedAt(report);
  const invocations =
    report.startedAt === undefined || ended === undefined
      ? []
      : [
          {
            startTimeUtc: report.startedAt,
            endTimeUtc: ended,
            executionSuccessful: report.summary.fail === 0,
          },
        ];

  return `${JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'workflow-tester',
              ...(options.version === undefined ? {} : { version: options.version }),
              informationUri: REPO_URI,
              rules: SARIF_RULES,
            },
          },
          ...(invocations.length === 0 ? {} : { invocations }),
          ...(report.nodeTypes === undefined ? {} : { properties: { nodeTypes: report.nodeTypes } }),
          results,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function githubActions(report: RunReport): string {
  return report.outcomes
    .filter((outcome) => outcome.status === 'fail' || outcome.status === 'warn')
    .map((outcome) => {
      const level = outcome.status === 'fail' ? 'error' : 'warning';
      const file = outcome.workflow ?? 'workflow.json';
      const title = (outcome.title ?? outcome.caseId).replace(/\n/g, ' ');
      const message = outcome.message.replace(/\n/g, ' ').replace(/::/g, ':');
      return `::${level} file=${file},title=${title}::${message}`;
    })
    .join('\n');
}

/** Render a report. Async because SARIF may consult the optional line mapper. */
export async function renderReport(
  report: RunReport,
  format: ReportFormat,
  options: RenderOptions = {},
): Promise<string> {
  switch (format) {
    case 'json':
      return `${JSON.stringify(report, null, 2)}\n`;
    case 'junit':
      return junit(report, options);
    case 'sarif':
      return await sarif(report, options);
    case 'github-actions':
      return githubActions(report);
    case 'stylish':
    default:
      return stylish(report);
  }
}
