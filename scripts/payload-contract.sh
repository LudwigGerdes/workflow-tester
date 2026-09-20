#!/usr/bin/env bash
# Resolves the payload-contract CLI and runs it.
#
# Runs payload-contract from a built checkout, for a consuming repo that does not
# install the npm package (there, `npx payload-contract` is all it takes).
# Point PAYLOAD_CONTRACT_HOME at that checkout. Left unset, this falls back to the
# directory above the script — which is the checkout itself, as long as the
# script has not been copied out of it.
#
# Absent, this is a no-op rather than a failure: a developer without the
# checkout should still be able to commit, and CI is the gate that cannot be
# skipped. A hook that blocks people who never asked for it gets uninstalled.
set -euo pipefail
home="${PAYLOAD_CONTRACT_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd || true)}"
cli="$home/packages/cli/dist/bin.js"
# Confirm it is actually an payload-contract checkout before running anything out of it.
# `packages/cli/dist/bin.js` is an ordinary path in any pnpm monorepo, so the
# fallback alone would happily exec a neighbouring project's binary.
if [ -z "$home" ] || [ ! -f "$cli" ] || \
   ! grep -q '"name": *"payload-contract-monorepo"' "$home/package.json" 2>/dev/null; then
  echo "payload-contract not found (set PAYLOAD_CONTRACT_HOME to its checkout, and run 'pnpm build' there) — skipping" >&2
  exit 0
fi
exec node "$cli" "$@"
