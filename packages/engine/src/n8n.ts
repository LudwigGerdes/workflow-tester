import { createRequire } from 'node:module';

/**
 * Single loading seam for `n8n-workflow`.
 *
 * Why this exists: `n8n-workflow@2.38.1` publishes an ESM build whose internal
 * imports are extensionless (`import * as LoggerProxy from './logger-proxy'`),
 * which Node's ESM resolver rejects with ERR_MODULE_NOT_FOUND. Its CJS build is
 * complete and loads cleanly, so we load that through `createRequire` and
 * re-export it under the package's own published types. This is a *loader*
 * detail only: the code that runs is n8n's, unmodified. Without it the sandbox
 * worker and the built CLI — both real Node ESM, not bundled by vitest — cannot
 * import the engine's one true dependency.
 *
 * Engine modules import runtime values from here and *types* straight from
 * `n8n-workflow` (type-only imports are erased, so they never hit the resolver).
 */
const require = createRequire(import.meta.url);

// `require` is untyped by construction; this single cast re-attaches the
// package's own types and is the only cast in the module.
const n8n = require('n8n-workflow') as typeof import('n8n-workflow');

export const {
  Workflow,
  WorkflowExpression,
  Expression,
  WorkflowDataProxy,
  ExpressionError,
  NodeHelpers,
  executeFilter,
  // `IRunExecutionData` is branded in 2.10.0 ("Use createRunExecutionData factory
  // instead of constructing manually"), so the run-data builder must go through
  // n8n's own factory rather than an object literal.
  createRunExecutionData,
} = n8n;
