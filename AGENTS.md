# Working on workflow-tester

workflow-tester generates and runs contract-driven tests for n8n workflows: from what a
workflow's trigger can receive it derives the payload variants that matter and
checks every expression against each one, offline, using n8n's own expression
engine. A case that reaches an HTTP call, a credentialed node, or a Code node
that calls out is reported as a boundary rather than executed.

## Layout

pnpm monorepo, one package per concern under `packages/`:

| Package | Role |
|---|---|
| `workflow-tester-paths` | `dataDir(kind)`: the one function that knows where shipped data lives (checkout, installed package, `WORKFLOW_TESTER_DATA`). |
| `workflow-tester-engine` | The reusable core: workflow + expression wiring, pure-node semantics, boundaries, the `node:vm` sandbox worker, node-description loading. Owns `bundled/` (n8n node descriptions). |
| `workflow-tester-contracts` | The contract model (`<workflow>.contract.yaml`), materialisation, capture/drift. |
| `workflow-tester-vendors` | Vendor webhook catalogs under `data/`, the ingest script, the coverage audit. |
| `workflow-tester-generator` | Turns a materialised contract into cases (examples, single mutations, pairs, budget). |
| `workflow-tester-structure` | Static reads of the workflow: which paths expressions touch, guard detection, lineage through Set and Code nodes. |
| `workflow-tester-runner` | Loads test files, runs cases through the engine in a worker pool, evaluates expectations, reporters (stylish, json, junit, sarif, github-actions). Owns `schema/workflow-tester.test.schema.json`. |
| `workflow-tester-instance` | Everything that talks to an n8n instance or the npm registry. The only networked package besides vendor ingestion. |
| `workflow-tester` (`packages/cli`) | The command-line entry point, and **the only published package**. Thin; commands live in `src/commands/`. Every other package is `private` and bundled into it. |

Dependency direction: `engine` ← `structure`, `contracts`, `generator` ←
`runner` ← `cli`; `vendors` and `instance` are leaves the cli pulls in; `paths`
sits under `engine`, `vendors` and `runner`.

## Prerequisites

- Node >= 24 (`engines` in `package.json`; CI runs 24 and 26). `n8n-workflow` 2.38 depends, through `@n8n/expression-runtime`, on the native module `isolated-vm` 7, which supports Node 24 and newer only (prebuilt binaries for Node 24 and 26; it cannot build on Node 20). workflow-tester never loads that module, but npm has to install it, so Node 24 is the floor. n8n 2.38 itself needs Node 24 when run from npm, so this matches the platform.
- pnpm 10 (`pnpm-lock.yaml` is lockfile v9; CI's `pnpm/action-setup@v4` reads the version from `packageManager`)

`pnpm install` warns that build scripts for `cpu-features`, `esbuild`,
`isolated-vm` and `ssh2` were ignored. That is expected and harmless: they are
transitive dependencies of `n8n-workflow`, and nothing here needs their native
builds. The sandbox uses `node:vm`, not `isolated-vm`.

## Commands

```bash
pnpm install
pnpm build          # tsc in every package, dependency order
pnpm typecheck      # tsc --noEmit in every package — build first (see below)
pnpm test           # vitest across the workspace (vitest.workspace.ts)
pnpm verify         # build, then typecheck, then test — what CI runs
pnpm smoke          # install-level acceptance test (see "Packaging" below)

pnpm --filter workflow-tester-engine test          # one package
cd packages/engine && pnpm vitest run test/walk.test.ts   # one file
```

**Build leads.** Packages expose their types from `dist/`, so typechecking a
dependent before its dependencies are built reports phantom missing-module
errors. Run `pnpm build` before `pnpm typecheck`; `pnpm verify` orders them.
The `development` export condition in each `package.json` lets vitest resolve
`src/` directly, which is why tests do not need a build — except the sandbox
worker and CLI end-to-end tests, whose `globalSetup` compiles the engine.

## Packaging: one published package

`packages/cli` publishes as `workflow-tester` (bin `workflow-tester`); nothing
else is published. How it holds together:

- **Bundle.** `packages/cli/scripts/build.mjs` (run by the cli's `build`, after
  `tsc --noEmit`) bundles every `workflow-tester-*` library from its
  TypeScript source into `packages/cli/dist` with esbuild (esm, node20,
  sourcemaps, `splitting` so shared code exists once). Third-party imports stay
  external and must be declared in `packages/cli/package.json` `dependencies`
  — today `n8n-workflow` (loaded through `createRequire`, so it must resolve
  from the installed package), `ajv`, `yaml`. An undeclared bare import fails
  the build, and `packages/cli/test/dist-deps.test.ts` checks the output again.
  The workspace libraries are the cli's `devDependencies`, which keeps pnpm's
  build order and never reaches a consumer.
- **Files loaded by path get their own entry point.** The sandbox worker is
  `dist/sandbox-worker.js`; `workerUrl()` in `packages/engine/src/sandbox/host.ts`
  finds it relative to the running module in all three layouts (vitest source,
  the engine's tsc output, the bundle). Never resolve such a file through a
  workspace package name.
- **Data.** `dataDir('node-types' | 'vendors' | 'schema')` from
  `workflow-tester-paths` is the only place that knows where data lives:
  `WORKFLOW_TESTER_DATA/<kind>` if set; else, in a checkout (recognised by
  `packages/vendors/sources.yaml` + `packages/engine/bundled` two levels up),
  the committed files where they are; else `<package>/data/<kind>`. The cli's
  `prepack` (`scripts/pack-files.mjs pre`) copies the data, LICENSE, README and
  THIRD_PARTY_NOTICES into `packages/cli/` and `postpack` removes them; the
  copies are gitignored. New shipped data means a new kind there, a line in
  `pack-files.mjs`, and an assertion in the smoke test.
- **The judge is `pnpm smoke`** (`scripts/smoke.sh [clone|npm|all]`): it clones
  the *committed* state, builds it and runs the README quickstart through
  `node packages/cli/dist/bin.js`; then `pnpm pack`s the cli, `npm install`s the
  tarball into an empty project outside the workspace and runs the same
  quickstart through `node_modules/.bin/workflow-tester`, plus tarball-content
  and data-override checks. Isolated `HOME` and `WORKFLOW_TESTER_CACHE`, temp
  dirs only. Commit before running it. Never make it pass by asserting less.

## Running the CLI from a checkout

After `pnpm build`:

```bash
node packages/cli/dist/bin.js --help
alias workflow-tester="node $PWD/packages/cli/dist/bin.js"     # for a shell session
```

`pnpm exec workflow-tester` does not work: pnpm does not link a workspace package's own
bin. `scripts/workflow-tester.sh` is the same invocation wrapped for a pre-commit hook
(it resolves `WORKFLOW_TESTER_HOME` and exits 0 when the checkout is absent).

## Fixtures and generated data

| What | Where | Regenerate |
|---|---|---|
| n8n node descriptions (42, n8n 2.10.0); ships as `data/node-types/` | `packages/engine/bundled/2.10.0/` | `pnpm bundle:node-types` (downloads `n8n-nodes-base` from npm) |
| Execution fixtures — real n8n execution exports the pure-node semantics are proven against | `packages/engine/test/fixtures/executions/` | Capture from a throwaway Docker n8n: `docs/maintainers/capturing-fixtures.md`. Never hand-write one. |
| Workflow fixtures for unit tests | `packages/*/test/fixtures/` | hand-written, small |
| Vendor catalogs | `packages/vendors/data/<vendor>/<specVersion>/catalog.json` | `pnpm ingest` in `packages/vendors` (network) after editing `sources.yaml` |
| Test-file JSON Schema | `packages/runner/schema/workflow-tester.test.schema.json` | hand-maintained; `workflow-tester schema` prints it |
| A consuming repo's `.workflow-tester/` | `contracts/`, `cases/`, `tests/` committed; `reports/` ignored | `workflow-tester gen`; `gen --check` guards staleness |

Both data folders carry a README stating provenance and licence. The bundled
descriptions are n8n's work under the Sustainable Use License; the engine runs
without them (`packages/engine/test/without-bundle.test.ts`).

## Conventions

- **Offline-first, no network in tests.** Exactly these commands may reach the
  network, each behind a flag: `contracts update --fetch`, `capture --instance`,
  `sync`, `node-types --version` / `--instance`. `gen`, `run` and `explain`
  never do. Networked code lives only in `workflow-tester-instance` and
  `packages/vendors/src/ingest.ts`; keep it there.
- **Reuse n8n, do not reimplement it.** Expressions are evaluated by
  `n8n-workflow` (`Expression`, `WorkflowDataProxy`), loaded through the single
  seam `packages/engine/src/n8n.ts`. Only the pure-node semantics under
  `packages/engine/src/semantics/` are ours, and each is proven against an
  execution fixture. On a disagreement the export wins; fix the semantics.
- **Boundaries are results, not failures.** A node the engine cannot run ends
  that path with a `boundary`; expectations past it report "needs a real
  execution". Never turn either into a pass or a fail. Respond to Webhook is
  interpreted (it hands its input on unchanged), so a webhook workflow that
  ends in one runs to its end.
- **Deterministic output.** Case ids are content hashes; generated files must
  regenerate byte-identically. No `Math.random`, `Date.now` or unsorted key
  iteration in the generator.
- **Strict TypeScript.** `tsconfig.base.json` sets `strict` and
  `noUncheckedIndexedAccess`. No `any`; prefer `unknown` and narrowing. No
  ESLint or Prettier config — match the surrounding style (2 spaces, single
  quotes, trailing commas).
- **Tests first** (vitest). Behaviour changes come with a test in the package
  that owns them. Error messages are part of the contract: many tests assert
  on them.
- **`WORKFLOW_TESTER_MODE`** decides whether `capture` and `sync` accept drift (`dev`)
  or only report it (unset/`test`); it never changes what counts as a pass.
  `gen` writes in every mode; `gen --check` is its read-only form.
- Keep `README.md`'s "What it does not do" and "Known issues" sections honest
  when behaviour changes.

## Adding things

- **A pure-node semantic:** add `packages/engine/src/semantics/<node>.ts`,
  register it in `semantics/index.ts`, and capture an execution fixture that
  exercises it (see the maintainer doc). A node kind is not done until it
  appears in a fixture.
- **A vendor:** add it to `packages/vendors/sources.yaml`, run `pnpm ingest`,
  commit the catalog, and update `packages/vendors/AUDIT.md` with what the
  vendor actually publishes.
- **A CLI command:** `packages/cli/src/commands/<name>.ts`, wired in
  `src/index.ts`, with its usage block added to `USAGE` there (that is what
  `workflow-tester <command> --help` prints; `--help` is routed before the command
  runs). Exit codes: 0 clean, 1 findings, 2 usage or configuration error.
- **A reporter:** `packages/runner/src/reporters/index.ts`.

## Do not

- Commit an execution export from a real instance without redacting it as
  `packages/engine/test/fixtures/executions/README.md` describes (hostnames,
  tokens, proxy headers, instance ids).
- Hand-write or "reconstruct" an execution fixture.
- Commit `.workflow-tester/reports/` or anything under `~/.workflow-tester/`.
- Read shipped data by a path built from `import.meta.url`; ask `dataDir`.
- Add a network call outside `workflow-tester-instance` or the vendor ingest script.
- Change `packages/engine/bundled/` by hand; regenerate it.
- Accept an API key as a CLI argument. `N8N_API_KEY` is environment-only.
