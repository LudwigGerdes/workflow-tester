#!/usr/bin/env bash
# Resolves the workflow-tester CLI and runs it.
#
# Runs workflow-tester from a built checkout, for a consuming repo that does not
# install the npm package (there, `npx workflow-tester` is all it takes).
# Point WORKFLOW_TESTER_HOME at that checkout. Left unset, this falls back to the
# directory above the script — which is the checkout itself, as long as the
# script has not been copied out of it.
#
# Absent, this is a no-op rather than a failure: a developer without the
# checkout should still be able to commit, and CI is the gate that cannot be
# skipped. A hook that blocks people who never asked for it gets uninstalled.
set -euo pipefail
home="${WORKFLOW_TESTER_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd || true)}"
cli="$home/packages/cli/dist/bin.js"
# Confirm it is actually an workflow-tester checkout before running anything out of it.
# `packages/cli/dist/bin.js` is an ordinary path in any pnpm monorepo, so the
# fallback alone would happily exec a neighbouring project's binary.
if [ -z "$home" ] || [ ! -f "$cli" ] || \
   ! grep -q '"name": *"workflow-tester-monorepo"' "$home/package.json" 2>/dev/null; then
  echo "workflow-tester not found (set WORKFLOW_TESTER_HOME to its checkout, and run 'pnpm build' there) — skipping" >&2
  exit 0
fi
exec node "$cli" "$@"
