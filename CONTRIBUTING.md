# Contributing to workflow-test

Thanks for looking. This is a one-maintainer project, so small, focused pull
requests with tests land fastest. `AGENTS.md` is the detailed guide to the
codebase (layout, conventions, fixtures); this page is the short version.

## Prerequisites

- Node >= 24 (CI runs 24 and 26)
- pnpm 10 (`corepack enable` picks up the pinned version from `package.json`)

## The dev loop

```bash
pnpm install
pnpm verify        # build → typecheck → test; what CI runs
pnpm smoke         # install-level: fresh clone + packed tarball, the README quickstart
```

`pnpm smoke` tests the **committed** state (it clones the repo), so commit
first. It is the only test that can see a dependency that was not declared or a
data file that did not ship; never make it pass by asserting less.

`build` must run before `typecheck`: packages expose their types from `dist`,
so typechecking a dependent before its dependencies are built reports phantom
missing-module errors. Tests need no build — a `development` export condition
points them at source — except the sandbox worker and the CLI end-to-end
tests, whose `globalSetup` compiles the engine.

Build order follows the dependency chain: `vendors`, `engine` → `contracts`
→ `structure`, `generator` → `runner` → `cli` (with `instance` as a leaf the
cli pulls in, and `paths` under everything that reads shipped data).
`pnpm build` handles it. Only `packages/cli` is published: its build
type-checks with `tsc` and then bundles every workspace library into
`packages/cli/dist` with esbuild. A new third-party import has to be added to
`packages/cli/package.json` `dependencies` as well as to the library that uses
it, or the bundle refuses to build.

One package: `pnpm --filter workflow-test-engine test`. One file:
`cd packages/engine && pnpm vitest run test/walk.test.ts`.

Run the CLI you just built: `node packages/cli/dist/bin.js --help`.

`pnpm install` warns that build scripts for `isolated-vm`, `esbuild`,
`cpu-features` and `ssh2` were skipped. That is expected: they are transitive
dependencies of `n8n-workflow`, and the sandbox uses `node:vm`.

## Adding a node semantics

The engine interprets a fixed set of n8n node kinds; everything else is a
boundary. To add one:

1. Write the failing test first: `packages/engine/test/semantics-<node>.test.ts`,
   driving `runSemantics` from `test/helpers.ts` with hand-built parameters.
   Pin the behaviour to n8n's own source for that node — say which version
   range you read.
2. Implement `packages/engine/src/semantics/<node>.ts` and register it in
   `semantics/index.ts` with the lowest `typeVersion` those semantics hold for.
3. Where you can, capture a real execution export that exercises it
   (`docs/maintainers/capturing-fixtures.md`) and add it to
   `test/execution-fixtures.test.ts`. Never hand-write a fixture.

## Adding a vendor

Add it to `packages/vendors/sources.yaml`, run `pnpm ingest` there (network),
commit the catalog under `data/`, and update `packages/vendors/AUDIT.md` with
what the vendor actually publishes.

## Adding a CLI command

`packages/cli/src/commands/<name>.ts`, wired in `src/index.ts`, with its usage
block added to `USAGE` there — that is what `workflow-test <command> --help` prints.
Exit codes: 0 clean, 1 findings, 2 usage or configuration error. Error
messages are part of the contract; tests assert on them.

## Pull requests

- Tests first; a behaviour change comes with a test in the package that owns it.
- Strict TypeScript: no `any`, prefer `unknown` and narrowing; no unchecked
  `as` casts. Match the surrounding style (2 spaces, single quotes, trailing
  commas); there is no linter config to run.
- Conventional commits (`fix:`, `feat:`, `docs:`, `test:`, `chore:`).
- No network calls outside `workflow-test-instance` and the vendor ingest script.
- `pnpm verify` green before you open the PR.

By contributing you agree that your work is licensed under the MIT license
that covers this repository.
