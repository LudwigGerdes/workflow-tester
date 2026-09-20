import type { Semantics } from '../types.js';
import { aggregateSemantics } from './aggregate.js';
import { codeSemantics } from './code.js';
import { filterSemantics } from './filter.js';
import { limitSemantics } from './limit.js';
import { removeDuplicatesSemantics } from './remove-duplicates.js';
import { renameKeysSemantics } from './rename-keys.js';
import { respondToWebhookSemantics } from './respond-to-webhook.js';
import { sortSemantics } from './sort.js';
import { splitOutSemantics } from './split-out.js';
import { stopAndError } from './stop-and-error.js';
import { ifSemantics } from './if.js';
import { mergeSemantics } from './merge.js';
import { noOpSemantics } from './noop.js';
import { setSemantics } from './set.js';
import { switchSemantics } from './switch.js';

/**
 * The expression-pure node kinds this engine interprets, with the lowest
 * typeVersion whose semantics these are. Everything absent from this table is a
 * boundary — that is the whole definition of "pure" here.
 */
const PURE: Record<string, { minVersion: number; semantics: Semantics }> = {
  'n8n-nodes-base.code': { minVersion: 2, semantics: codeSemantics },
  'n8n-nodes-base.set': { minVersion: 3, semantics: setSemantics },
  'n8n-nodes-base.if': { minVersion: 2, semantics: ifSemantics },
  'n8n-nodes-base.filter': { minVersion: 2, semantics: filterSemantics },
  'n8n-nodes-base.noOp': { minVersion: 1, semantics: noOpSemantics },
  'n8n-nodes-base.switch': { minVersion: 3, semantics: switchSemantics },
  'n8n-nodes-base.merge': { minVersion: 3, semantics: mergeSemantics },
  'n8n-nodes-base.renameKeys': { minVersion: 1, semantics: renameKeysSemantics },
  'n8n-nodes-base.splitOut': { minVersion: 1, semantics: splitOutSemantics },
  'n8n-nodes-base.aggregate': { minVersion: 1, semantics: aggregateSemantics },
  'n8n-nodes-base.limit': { minVersion: 1, semantics: limitSemantics },
  'n8n-nodes-base.removeDuplicates': { minVersion: 2, semantics: removeDuplicatesSemantics },
  'n8n-nodes-base.sort': { minVersion: 1, semantics: sortSemantics },
  'n8n-nodes-base.stopAndError': { minVersion: 1, semantics: stopAndError },
  'n8n-nodes-base.respondToWebhook': { minVersion: 1, semantics: respondToWebhookSemantics },
};

/** Semantics for a node kind, or undefined when it is a boundary. */
/**
 * The node types the engine interprets, as bare n8n names.
 *
 * Exported so the extractor's allowlist is derived from the registry rather
 * than repeated beside it — adding a semantics without extracting its
 * description would otherwise fail only at run time, on someone else's machine.
 */
export function pureTypeNames(): string[] {
  return Object.keys(PURE).map((type) => type.replace(/^n8n-nodes-base\./, ''));
}

export function semanticsFor(type: string, typeVersion: number): Semantics | undefined {
  const entry = PURE[type];
  if (entry === undefined || typeVersion < entry.minVersion) return undefined;
  return entry.semantics;
}

/**
 * Whether this node kind is one we interpret at *some* version. Lets the walker
 * distinguish "we do not interpret this node" (`not-pure`) from "we interpret it,
 * but not at this typeVersion" (`unsupported-mode`).
 */
export function isPureType(type: string): boolean {
  return type in PURE;
}

export {
  codeSemantics,
  setSemantics,
  ifSemantics,
  filterSemantics,
  noOpSemantics,
  switchSemantics,
  mergeSemantics,
  renameKeysSemantics,
  splitOutSemantics,
  aggregateSemantics,
  limitSemantics,
  removeDuplicatesSemantics,
  sortSemantics,
  respondToWebhookSemantics,
};
