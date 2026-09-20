import type { INodeTypeDescription } from 'n8n-workflow';
import { pureTypeNames } from '../semantics/index.js';

/**
 * Trigger types. A workflow starts at one, so its description is needed to
 * resolve the trigger node's own parameters.
 */
const TRIGGERS = [
  'webhook',
  'formTrigger',
  'manualTrigger',
  'scheduleTrigger',
  'executeWorkflowTrigger',
  'errorTrigger',
  'cron',
  'interval',
  'emailReadImap',
];

/**
 * Types the engine does not interpret but still meets constantly.
 *
 * Keeping them is not cosmetic: a known type ends a path as a `not-pure`
 * boundary carrying its real type name, where an unknown one is a boundary
 * with less to say. All of them appear in this repository's own test corpus.
 */
const ALSO_KEPT = [
  'httpRequest',
  'splitInBatches',
  'executeWorkflow',
  'respondToWebhook',
  'stickyNote',
];

/** Every node type payload-contract extracts a description for. */
export const NEEDED_TYPES: string[] = [...new Set([...pureTypeNames(), ...TRIGGERS, ...ALSO_KEPT])];

/**
 * Fields kept.
 *
 * `properties` and `version` are what `requiredUndefined` and
 * `NodeHelpers.displayParameter` read; `inputs`/`outputs` shape the walk;
 * `displayName`, `group` and `defaults` are read by n8n's own `Workflow`
 * construction. Everything else — `codex`, `credentials`, `iconUrl`,
 * `subtitle`, `description`, `usableAsTool` — is editor metadata, and it is
 * where nearly all the size lives.
 */
const KEPT = [
  'displayName',
  'name',
  'group',
  'version',
  'defaults',
  'inputs',
  'outputs',
  'properties',
] as const;

/** `set` becomes `n8n-nodes-base.set`; an already-qualified name is left alone. */
const qualify = (name: string): string => (name.includes('.') ? name : `n8n-nodes-base.${name}`);

/** The reverse, so the allowlist matches whichever form the input uses. */
const bare = (name: string): string => name.replace(/^n8n-nodes-base\./, '');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Reduce n8n's published description dump to what payload-contract reads.
 *
 * Pure and total: a malformed entry is skipped rather than thrown over, because
 * the input is 500 entries of someone else's published data and one bad one
 * must not cost the other 499.
 */
export function harvest(
  all: unknown[],
  options: { all?: boolean } = {},
): INodeTypeDescription[] {
  const wanted = new Set(NEEDED_TYPES);
  const out: INodeTypeDescription[] = [];

  for (const entry of all) {
    if (!isRecord(entry)) continue;
    if (typeof entry['name'] !== 'string') continue;
    // The allowlist shrinks n8n's 500-entry dump. It must not be applied to a
    // file someone wrote by hand: a custom node is never in it, and filtering
    // there would throw away the very descriptions `--from` exists to load.
    if (options.all !== true && !wanted.has(bare(entry['name']))) continue;
    if (!Array.isArray(entry['properties'])) continue;

    const trimmed: Record<string, unknown> = {};
    for (const field of KEPT) {
      if (entry[field] !== undefined) trimmed[field] = entry[field];
    }
    // n8n publishes the name bare — `set` — but a workflow refers to the type
    // as `n8n-nodes-base.set`, and that is what a description served to the
    // engine has always carried. Aliasing the lookup key is not enough: the
    // name inside the description is read too, so it is qualified here rather
    // than left to differ from what every consumer expects.
    trimmed['name'] = qualify(entry['name']);
    out.push(trimmed as unknown as INodeTypeDescription);
  }

  return out;
}
