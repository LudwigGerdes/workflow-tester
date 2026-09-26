import { isAbsolute, resolve } from 'node:path';
import type { RunReport } from '../run.js';
import type { Outcome } from '../oracle.js';

export interface RenderOptions {
  /** Directory the workflow paths in the report are relative to. */
  root?: string;
}

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

function junit(report: RunReport): string {
  const cases = report.outcomes
    .map((outcome) => {
      const name = escapeXml(outcome.title ?? outcome.caseId);
      const classname = escapeXml(outcome.workflow ?? 'workflow-tester');
      const open = `    <testcase name="${name}" classname="${classname}">`;
      if (outcome.status === 'pass') return `${open.slice(0, -1)}/>`;
      if (outcome.status === 'needs-execution') {
        return `${open}\n      <skipped message="${escapeXml(outcome.message)}"/>\n    </testcase>`;
      }
      const tag = outcome.status === 'fail' ? 'failure' : 'system-out';
      return `${open}\n      <${tag} message="${escapeXml(outcome.message)}"/>\n    </testcase>`;
    })
    .join('\n');

  const { pass, fail, warn, needsExecution } = report.summary;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites>',
    `  <testsuite name="workflow-tester" tests="${pass + fail + warn + needsExecution}" failures="${fail}" skipped="${needsExecution}">`,
    cases,
    '  </testsuite>',
    '</testsuites>',
  ].join('\n');
}

async function sarif(report: RunReport, options: RenderOptions): Promise<string> {
  const root = options.root ?? process.cwd();

  const results = report.outcomes
    .filter((outcome) => outcome.status === 'fail' || outcome.status === 'warn')
    .map((outcome) => {
      const uri = outcome.workflow ?? 'workflow.json';
      // SARIF wants a repo-relative URI, but the adapter opens the file itself
      // and so needs one that resolves from here. Passing the relative path to
      // both would make line mapping fail silently and look like it worked.
      const readable = isAbsolute(uri) ? uri : resolve(root, uri);
      return {
        ruleId: `workflow-tester/${outcome.status === 'fail' ? 'case-failed' : 'case-warned'}`,
        level: outcome.status === 'fail' ? 'error' : 'warning',
        message: { text: `${outcome.title ?? outcome.caseId}: ${outcome.message}` },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri },
              // File-level: workflow-tester does not read the workflow file itself,
              // so it has no line to point at.
            },
          },
        ],
      };
    });

  return `${JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [{ tool: { driver: { name: 'workflow-tester', informationUri: 'https://github.com/LudwigGerdes/workflow-tester' } }, results }],
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
      return junit(report);
    case 'sarif':
      return await sarif(report, options);
    case 'github-actions':
      return githubActions(report);
    case 'stylish':
    default:
      return stylish(report);
  }
}
