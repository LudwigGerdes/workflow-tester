import { createRequire } from 'node:module';

/**
 * `n8n-workflow@2.10.0`'s ESM build has extensionless internal imports that
 * Node's resolver rejects, so the CJS build is loaded instead — the same seam
 * `workflow-tester-engine` uses, kept local so the generator does not depend on it.
 */
const require = createRequire(import.meta.url);
const n8n = require('n8n-workflow') as typeof import('n8n-workflow');

export const { ExpressionParser } = n8n;
