# Changelog

All notable changes to workflow-tester are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Tests are found at any depth under `.workflow-tester/tests/` (dot directories and `node_modules` skipped), and `testsDirs` in `.workflow-tester/config.yaml` names other directories to read them from, such as `workflows` for tests kept beside their workflow.
- Reports carry timings and identity. JUnit: one `<testsuite>` per workflow with counts and `time`, `time` per case, and properties naming the workflow-tester version and the node descriptions used. SARIF: the real tool version, a rule entry per result kind with a help link, node-level locations (logical location and the line the workflow names the node on), `partialFingerprints` per case, an invocation with start and end times. The JSON report and `last.json` carry `startedAt` and per-outcome `durationMs`.
- Captures record their provenance: tool version, source (export file, or the instance's base URL — never the key), execution id and status, and the workflow's id, name and `versionId`. Older captures without these fields still read.
- `given.pinData` is honoured: items pinned per node stand in for a node the engine cannot run (an HTTP Request, a credentialed node, a Code node that calls out), so the walk carries on past it. A file-level `given` applies to every case; a case's own pins win. A pin naming a node the workflow does not have fails the case.
- `source.kind: schema`: a contract can point at a JSON Schema file of your own (`contracts add --schema <file> [--examples <path>] [--name <n>]`), so `gen` works for any webhook, not only the GitHub and Stripe catalogues. Examples are a directory of `.json` files or one file holding a list, each validated against the schema before it is kept. The schema is copied into the shape and its digest is the contract's version.

### Changed

- `given.snapshot`, `packs`, `seed` and `faults` are refused at load with the line number. They validated before but nothing read them, so a case declaring a fault passed for the wrong reason.

## 0.2.0 — 2026-09-21

### Added

- `vendors events <vendor>` lists the event names `contracts add --events` accepts, one per line.

### Fixed

- A generated case whose change is at the payload root no longer has a double space in its title (`oneOf-branch (branch 0)`).
- The test-file JSON Schema's description of `given.pinData` no longer refers to an internal design document.

### Changed

- README cut down to description, installation, getting started and core usage; the reference moved to `docs/` (`cli.md`, `writing-tests.md`, `generated-tests.md`, `capture.md`, `ci.md`, `faq.md`). `walkthrough.md` is folded into `generated-tests.md`.
- README: an npm quickstart that reproduces the hero as pasted, what the `npm install` warning means, what Node 20 users see, and where an execution export for `capture` comes from.
- `docs/demo/issue-triage.json`: the workflow behind the `gen` and `run --only generated` transcripts.

## 0.1.0 — 2026-09-20

Initial public release.

### Changed

- **Renamed** to workflow-tester before the first release:
  the package, the binary, the `WORKFLOW_TESTER_*` environment variables, the
  `.workflow-tester/` project directory and `~/.workflow-tester` all follow the new name.
- **One package.** `workflow-tester` is now the only published package and is
  self-contained: the internal libraries (`workflow-tester-engine`, `-runner`,
  `-contracts`, `-generator`, `-structure`, `-vendors`, `-instance`) are private
  and bundled into it, and the node descriptions, vendor catalogues and
  test-file schema ship inside it under `data/`. Installing the tarball used to
  fail with E404 on those libraries. `n8n-workflow`, `ajv` and `yaml` remain
  ordinary dependencies. The package has no programmatic API; it no longer
  declares a `main` or a `.` export.
- **Node >= 24 is now required.** The install-level smoke test found that plain
  `npm install` fails on Node 20, because `n8n-workflow` 2.38 pulls in the native
  module `isolated-vm` 7, which supports Node 24 and newer only.
- `WORKFLOW_TESTER_DATA=<dir>` overrides where the shipped data is read from
  (`<dir>/node-types`, `<dir>/vendors`, `<dir>/schema`).

### Fixed

- Respond to Webhook is interpreted instead of treated as a boundary: it hands
  its input on unchanged (n8n's own `execute` ends in `return [items]`), and
  from v1.3 / v1.4 with the response output enabled its second output carries
  the response as n8n builds it. A webhook workflow that ends in one now runs
  to its end, so `execution.status: success` can hold and the summary no
  longer reads `0 passed` with every case at "needs a real execution".
  A response body that resolves to `undefined` is a warning, as a Set
  assignment is. `jwt` (needs a credential) and `binary` stay boundaries.
- `workflow-tester gen` writes by default. It used to write nothing unless
  `WORKFLOW_TESTER_MODE=dev`, and told you to run the command you had just run.
  `gen --check` is the read-only form for pre-commit and CI, in every mode.
- `--help` / `-h` is honoured by every command and prints that command's
  usage (`run --help` used to run the suite; `init --help` scaffolded;
  `node-types --help` refused). `workflow-tester help <command>` does the same.
- `--version` / `-v`.
- `run <workflow.json>` exits 2 with a one-line error when the file does not
  exist or is not JSON, instead of `0 passed` and exit 0.
- `contracts add` validates the events against the vendor catalog before
  anything is written (staged to a temporary file, renamed into place on
  success), so a typo leaves no broken contract behind. On an existing
  contract a later `--events` (or `--vendor`) replaces the old one, keeping
  comments and `overrides`; before, the file's events silently beat the flag.
- The stylish reporter prints each structure finding (`"profile" is not
  produced here`, with the node and parameter) under its case, and names the
  boundary node when `execution.status` cannot be judged. Both used to be
  visible only in `--format json`.
- The `init` scaffold no longer says "needs tier 2".

### Added

- `pnpm smoke` (`scripts/smoke.sh [clone|npm|all]`): an install-level acceptance
  test that runs the README quickstart from a fresh clone and from the packed
  tarball installed into an empty project. CI runs it on Ubuntu and macOS,
  Node 24 and 26, and lints the package with publint and arethetypeswrong.
- Community files: CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, issue and pull
  request templates.
