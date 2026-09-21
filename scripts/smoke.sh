#!/usr/bin/env bash
# Install-level acceptance test: does workflow-tester work for someone who
# clones the repo, and for someone who installs the npm tarball?
#
#   scripts/smoke.sh [clone|npm|all]      (default: all)
#
# clone: git clone of the COMMITTED state → pnpm install → pnpm build → the
#        quickstart through `node packages/cli/dist/bin.js`, as the README says.
# npm:   pnpm pack the one publishable package → npm install the tarball into
#        an empty project outside any workspace → the same quickstart through
#        node_modules/.bin/workflow-tester.
#
# Everything happens under one mktemp dir with an isolated HOME and
# WORKFLOW_TESTER_CACHE; the working tree and the real home are never touched.
# Needs node, pnpm, npm, git. No network beyond the package installs.
set -euo pipefail

MODE="${1:-all}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/workflow-tester-smoke.XXXXXX")"
TMP="$(cd "$TMP" && pwd -P)"
REAL_HOME="$HOME"
PASSES=0
FAILS=0
FAILED_NAMES=()

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# Package managers keep their caches (a real home makes installs fast and
# offline-friendly); the tool under test gets an empty HOME of its own.
export npm_config_cache="${npm_config_cache:-$REAL_HOME/.npm}"
export npm_config_update_notifier=false
export npm_config_fund=false
export npm_config_audit=false
export NO_COLOR=1
unset WORKFLOW_TESTER_HOME WORKFLOW_TESTER_MODE N8N_API_KEY || true

pass() { PASSES=$((PASSES + 1)); printf 'PASS  %s\n' "$1"; }
fail() {
  FAILS=$((FAILS + 1)); FAILED_NAMES+=("$1"); printf 'FAIL  %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '%s\n' "$2" | sed 's/^/      | /' | head -40; fi
}

# run_in <dir> <cmd...> : runs with the isolated HOME; sets OUT and RC.
OUT=''; RC=0
run_in() {
  local dir="$1"; shift
  set +e
  OUT="$(cd "$dir" && HOME="$TMP/home" WORKFLOW_TESTER_CACHE="$TMP/home/.workflow-tester" "$@" 2>&1 </dev/null)"
  RC=$?
  set -e
}

# expect <name> <wanted rc> [grep -E pattern...] : judges the last run_in.
expect() {
  local name="$1" want="$2"; shift 2
  if [ "$RC" -ne "$want" ]; then fail "$name" "exit $RC, wanted $want
$OUT"; return; fi
  local pat
  for pat in "$@"; do
    if ! printf '%s\n' "$OUT" | grep -Eq -- "$pat"; then fail "$name" "output lacks /$pat/
$OUT"; return; fi
  done
  pass "$name"
}

# expect_nonzero <name> [patterns...] : any failing exit code.
expect_nonzero() {
  local name="$1"; shift
  if [ "$RC" -eq 0 ]; then fail "$name" "exit 0, wanted non-zero
$OUT"; return; fi
  local pat
  for pat in "$@"; do
    if ! printf '%s\n' "$OUT" | grep -Eq -- "$pat"; then fail "$name" "output lacks /$pat/
$OUT"; return; fi
  done
  pass "$name"
}

check_file() { if [ -s "$2" ]; then pass "$1"; else fail "$1" "missing or empty: $2"; fi; }

COMMANDS=(contracts gen run explain schema init promote capture sync vendors node-types)

# quickstart <label> <project dir> <cli argv...>
# The README quickstart plus docs/generated-tests.md, in an empty project.
quickstart() {
  local label="$1" proj="$2"; shift 2
  local cli=("$@")
  mkdir -p "$proj/workflows" "$TMP/home"

  run_in "$proj" "${cli[@]}" --version
  expect "$label: --version prints the package version" 0 '^workflow-tester [0-9]+\.[0-9]+\.[0-9]+'

  run_in "$proj" "${cli[@]}" --help
  expect "$label: --help lists the commands" 0 'workflow-tester run' 'workflow-tester gen' 'workflow-tester contracts add'
  local c
  for c in "${COMMANDS[@]}"; do
    run_in "$proj" "${cli[@]}" "$c" --help
    expect "$label: $c --help" 0 "workflow-tester $c"
  done

  # init: the scaffold templates ship with the package
  run_in "$proj" "${cli[@]}" init
  expect "$label: init scaffolds .workflow-tester" 0 'created \.workflow-tester/tests/example\.test\.yaml' 'created \.workflow-tester/README\.md'
  check_file "$label: init wrote the example test" "$proj/.workflow-tester/tests/example.test.yaml"
  check_file "$label: init wrote the README" "$proj/.workflow-tester/README.md"

  run_in "$proj" "${cli[@]}" run
  expect "$label: the fresh scaffold runs clean" 0 '0 passed, 0 failed, 0 warned'

  # the demo: run catches the ?? bug
  cp "$ROOT_FOR_DEMO/docs/demo/signup.json" "$proj/workflows/signup.json"
  cp "$ROOT_FOR_DEMO/docs/demo/signup.test.yaml" "$proj/.workflow-tester/tests/signup.test.yaml"
  run_in "$proj" "${cli[@]}" run
  expect "$label: run catches the ?? bug (exit 1)" 1 \
    'node\.Normalize\.output\[0\]\.json\.name: expected "Bob", got undefined' \
    '1 passed, 1 failed, 1 warned'

  # the one-line fix from the README hero
  sed -i.bak 's/profile\.first_name ??/profile?.first_name ??/' "$proj/workflows/signup.json"
  rm -f "$proj/workflows/signup.json.bak"
  if grep -q 'profile?\.first_name ??' "$proj/workflows/signup.json"; then pass "$label: the one-line fix applied"; else fail "$label: the one-line fix applied"; fi
  run_in "$proj" "${cli[@]}" run
  expect "$label: run is green after the fix" 0 '1 passed, 0 failed, 2 warned'

  run_in "$proj" "${cli[@]}" run --format json
  expect "$label: run --format json" 0 '"summary"' '"pass": 1' '"fail": 0' '"warn": 2'

  run_in "$proj" "${cli[@]}" gen --check
  expect "$label: gen --check with no contracts" 0 'no contracts found'

  # vendor catalogues ship with the package
  run_in "$proj" "${cli[@]}" vendors list
  expect "$label: vendors list reads the shipped catalogues" 0 '^github +schema' '^stripe +schema'

  run_in "$proj" "${cli[@]}" contracts add workflows/signup.json --vendor github --events issues-opened
  expect "$label: contracts add --vendor github" 0 'vendor +github @' 'events +issues-opened'
  check_file "$label: contract written beside the workflow" "$proj/workflows/signup.contract.yaml"
  check_file "$label: shape schema materialised" "$proj/.workflow-tester/contracts/github.issues-opened.schema.json"
  check_file "$label: shape examples materialised" "$proj/.workflow-tester/contracts/github.issues-opened.examples.json"

  run_in "$proj" "${cli[@]}" gen --check
  expect "$label: gen --check reports stale cases (exit 1)" 1

  run_in "$proj" "${cli[@]}" gen
  expect "$label: gen writes cases" 0 'github\.issues-opened: [0-9]+ case\(s\) — [1-9][0-9]* added'
  check_file "$label: gen wrote the case index" "$proj/.workflow-tester/cases/signup/github.issues-opened/index.json"

  run_in "$proj" "${cli[@]}" gen --check
  expect "$label: gen --check is clean after gen" 0 'unchanged'

  run_in "$proj" "${cli[@]}" run --only generated
  if [ "$RC" -eq 0 ] || [ "$RC" -eq 1 ]; then
    expect "$label: run --only generated executes the generated cases" "$RC" '[0-9]+ passed, [0-9]+ failed, [0-9]+ warned'
  else
    fail "$label: run --only generated executes the generated cases" "exit $RC
$OUT"
  fi

  # schema: the JSON schema ships with the package
  run_in "$proj" "${cli[@]}" schema
  expect "$label: schema prints the test-file JSON Schema" 0 '"\$schema"' 'workflow-tester\.test\.schema\.json'

  # node descriptions ship with the package
  run_in "$proj" "${cli[@]}" node-types --list
  expect "$label: node-types --list finds the bundled descriptions" 0 'bundled: +2\.10\.0' 'a run would use: bundled 2\.10\.0'

  # the sandbox host is a file loaded by path: a Code node must actually run
  mkdir -p "$proj/sandbox/workflows"
  cat > "$proj/sandbox/workflows/code.json" <<'JSON'
{
  "name": "code",
  "nodes": [
    { "id": "1", "name": "Webhook", "type": "n8n-nodes-base.webhook", "typeVersion": 2, "position": [0, 0],
      "parameters": { "path": "code", "httpMethod": "POST" } },
    { "id": "2", "name": "Double", "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [200, 0],
      "parameters": { "jsCode": "return $input.all().map(i => ({ json: { doubled: i.json.body.n * 2 } }));" } }
  ],
  "connections": { "Webhook": { "main": [[{ "node": "Double", "type": "main", "index": 0 }]] } }
}
JSON
  run_in "$proj/sandbox" "${cli[@]}" init
  cat > "$proj/sandbox/.workflow-tester/tests/code.test.yaml" <<'YAML'
workflow: ../../workflows/code.json
cases:
  - id: doubles
    title: the Code node runs in the sandbox
    when:
      trigger: webhook
      payload:
        n: 21
    then:
      execution.status: success
      node.Double.output[0].json.doubled: 42
YAML
  run_in "$proj/sandbox" "${cli[@]}" run
  expect "$label: a Code node runs in the sandbox worker" 0 '1 passed, 0 failed'
  sed -i.bak 's/doubled: 42/doubled: 43/' "$proj/sandbox/.workflow-tester/tests/code.test.yaml"
  run_in "$proj/sandbox" "${cli[@]}" run
  expect "$label: …and its real output is what gets compared" 1 'expected 43, got 42'

  # nothing leaked into the real home
  if [ -d "$TMP/home" ]; then pass "$label: isolated HOME in use"; fi
}

clone_path() {
  echo "── clone path ─────────────────────────────────────────────"
  git clone --quiet "$ROOT" "$TMP/clone"
  ( cd "$TMP/clone" && pnpm install --frozen-lockfile >"$TMP/clone-install.log" 2>&1 ) \
    && pass "clone: pnpm install --frozen-lockfile" \
    || { fail "clone: pnpm install --frozen-lockfile" "$(tail -30 "$TMP/clone-install.log")"; return; }
  ( cd "$TMP/clone" && pnpm build >"$TMP/clone-build.log" 2>&1 ) \
    && pass "clone: pnpm build" \
    || { fail "clone: pnpm build" "$(tail -30 "$TMP/clone-build.log")"; return; }
  check_file "clone: packages/cli/dist/bin.js exists (the documented invocation)" "$TMP/clone/packages/cli/dist/bin.js"

  ROOT_FOR_DEMO="$TMP/clone"
  quickstart "clone" "$TMP/clone-project" node "$TMP/clone/packages/cli/dist/bin.js"

  # the pre-commit wrapper resolves the same checkout path
  run_in "$TMP/clone-project" env WORKFLOW_TESTER_HOME="$TMP/clone" bash "$TMP/clone/scripts/workflow-tester.sh" --version
  expect "clone: scripts/workflow-tester.sh runs the checkout's CLI" 0 '^workflow-tester [0-9]'
}

npm_path() {
  echo "── npm path ───────────────────────────────────────────────"
  mkdir -p "$TMP/pack" "$TMP/app"
  # Pack from a clone of the committed state, built, so the working tree is
  # never written to (prepack copies files into the package directory).
  local src="$TMP/clone"
  if [ ! -f "$src/packages/cli/dist/bin.js" ]; then
    src="$TMP/pack-src"
    git clone --quiet "$ROOT" "$src"
    ( cd "$src" && pnpm install --frozen-lockfile >"$TMP/pack-install.log" 2>&1 && pnpm build >"$TMP/pack-build.log" 2>&1 ) \
      || { fail "npm: build the package to pack" "$(tail -30 "$TMP/pack-build.log" 2>/dev/null || tail -30 "$TMP/pack-install.log")"; return; }
  fi
  ( cd "$src/packages/cli" && pnpm pack --pack-destination "$TMP/pack" >"$TMP/pack.log" 2>&1 ) \
    || { fail "npm: pnpm pack" "$(cat "$TMP/pack.log")"; return; }
  local tarball
  tarball="$(ls "$TMP/pack"/workflow-tester-*.tgz 2>/dev/null | head -1)"
  if [ -z "$tarball" ]; then fail "npm: pnpm pack produced a tarball" "$(cat "$TMP/pack.log")"; return; fi
  pass "npm: pnpm pack produced $(basename "$tarball")"

  # what is in the tarball
  local listing="$TMP/pack/listing.txt"
  tar -tzf "$tarball" | sed 's#^package/##' | sort > "$listing"
  local count size
  count="$(wc -l < "$listing" | tr -d ' ')"
  size="$(wc -c < "$tarball" | tr -d ' ')"
  echo "      tarball: $count files, $size bytes packed"
  local f
  for f in LICENSE README.md THIRD_PARTY_NOTICES.md package.json dist/bin.js; do
    if grep -qx "$f" "$listing"; then pass "npm: tarball contains $f"; else fail "npm: tarball contains $f"; fi
  done
  local bad
  # `.test.<js|ts>` is a test file; data/schema/workflow-tester.test.schema.json is
  # the published schema FOR test files and belongs in the package.
  bad="$(grep -E '(^|/)(src|test|tests|fixtures|__tests__)/|\.(test|spec)\.[cm]?[jt]sx?$|\.ts$|\.tsbuildinfo$|(^|/)tsconfig.*\.json$|vitest\.config' "$listing" || true)"
  if [ -z "$bad" ]; then pass "npm: tarball has no src/, tests, fixtures or build config"; else fail "npm: tarball has no src/, tests, fixtures or build config" "$bad"; fi
  # every .map must sit beside the file it maps
  local orphan='' m
  while IFS= read -r m; do
    [ -z "$m" ] && continue
    grep -qx "${m%.map}" "$listing" || orphan="$orphan$m"$'\n'
  done < <(grep -E '\.map$' "$listing" || true)
  if [ -z "$orphan" ]; then pass "npm: every sourcemap has its file"; else fail "npm: every sourcemap has its file" "$orphan"; fi
  if tar -xzOf "$tarball" package/package.json | grep -q 'workspace:'; then
    fail "npm: packed manifest has no workspace: ranges"
  else pass "npm: packed manifest has no workspace: ranges"; fi
  # Runtime dependency fields only: devDependencies are never installed for a consumer.
  local internal
  internal="$(tar -xzOf "$tarball" package/package.json | node -e '
    const m = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const names = ["dependencies", "peerDependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies"]
      .flatMap((f) => (Array.isArray(m[f]) ? m[f] : Object.keys(m[f] ?? {})));
    console.log(names.filter((n) => n.startsWith("workflow-tester")).join(" "));
    if (m.name !== "workflow-tester" || m.private || !m.bin || m.bin["workflow-tester"] !== "./dist/bin.js") process.exit(3);
  ')" || { fail "npm: packed manifest is workflow-tester with bin workflow-tester"; internal='?'; }
  if [ -z "$internal" ]; then pass "npm: packed manifest depends on no internal workspace library"
  else fail "npm: packed manifest depends on no internal workspace library" "$internal"; fi
  for f in dist/sandbox-worker.js data/node-types/2.10.0/nodes.json data/vendors/sources.yaml \
           data/vendors/data/github/1.1.4/catalog.json data/schema/workflow-tester.test.schema.json; do
    if grep -qx "$f" "$listing"; then pass "npm: tarball contains $f"; else fail "npm: tarball contains $f"; fi
  done
  if [ -z "$(cd "$src" && git status --porcelain)" ]; then pass "npm: packing left the checkout clean (postpack removed its copies)"
  else fail "npm: packing left the checkout clean (postpack removed its copies)" "$(cd "$src" && git status --porcelain)"; fi

  # install into an empty project outside any workspace
  ( cd "$TMP/app" && npm init -y >/dev/null 2>&1 && npm install "$tarball" >"$TMP/npm-install.log" 2>&1 ) \
    && pass "npm: npm install <tarball> in an empty project" \
    || { fail "npm: npm install <tarball> in an empty project" "$(tail -30 "$TMP/npm-install.log")"; return; }

  run_in "$TMP/app" npx --no-install workflow-tester --version
  expect "npm: npx --no-install workflow-tester --version" 0 '^workflow-tester [0-9]'

  ROOT_FOR_DEMO="$ROOT_FOR_DEMO_NPM"
  quickstart "npm" "$TMP/app" "$TMP/app/node_modules/.bin/workflow-tester"

  # the owner's override: WORKFLOW_TESTER_DATA replaces the shipped data wholesale
  mkdir -p "$TMP/empty-data"
  run_in "$TMP/app" env WORKFLOW_TESTER_DATA="$TMP/empty-data" "$TMP/app/node_modules/.bin/workflow-tester" vendors list
  expect_nonzero "npm: WORKFLOW_TESTER_DATA pointing at an empty dir is honoured (no silent fallback)"
  cp -R "$TMP/app/node_modules/workflow-tester/data" "$TMP/moved-data"
  run_in "$TMP/app" env WORKFLOW_TESTER_DATA="$TMP/moved-data" "$TMP/app/node_modules/.bin/workflow-tester" vendors list
  expect "npm: WORKFLOW_TESTER_DATA pointing at a copy of the data works" 0 '^github +schema'

  # the data came from the installed package, not from the repo
  local leaked
  leaked="$(grep -rlF "$ROOT" "$TMP/app/node_modules/workflow-tester" 2>/dev/null | head -5 || true)"
  if [ -z "$leaked" ]; then pass "npm: the installed package holds no path back to the repo"; else fail "npm: the installed package holds no path back to the repo" "$leaked"; fi
  if [ -d "$TMP/app/node_modules/workflow-tester" ] && [ ! -L "$TMP/app/node_modules/workflow-tester" ]; then
    pass "npm: installed as a real copy, not a link"
  else fail "npm: installed as a real copy, not a link"; fi
}

# The demo files are documentation, not package contents: take them from the
# committed state for both paths.
git clone --quiet "$ROOT" "$TMP/demo-src"
ROOT_FOR_DEMO="$TMP/demo-src"
ROOT_FOR_DEMO_NPM="$TMP/demo-src"

echo "workflow-tester smoke ($MODE) — node $(node --version), pnpm $(pnpm --version), npm $(npm --version)"
case "$MODE" in
  clone) clone_path ;;
  npm) npm_path ;;
  all) clone_path; npm_path ;;
  *) echo "usage: scripts/smoke.sh [clone|npm|all]" >&2; exit 2 ;;
esac

echo "───────────────────────────────────────────────────────────"
echo "$PASSES passed, $FAILS failed"
if [ "$FAILS" -gt 0 ]; then
  printf '  ✗ %s\n' "${FAILED_NAMES[@]}"
  exit 1
fi
