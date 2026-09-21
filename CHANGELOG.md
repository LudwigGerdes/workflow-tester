# Changelog

All notable changes to workflow-test are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Renamed** to workflow-test before the first release (the working name was
  "payload contract"):
  the package, the binary, the `WORKFLOW_TEST_*` environment variables, the
  `.workflow-test/` project directory and `~/.workflow-test` all follow the new name.
- **One package.** `workflow-test` is now the only published package and is
  self-contained: the internal libraries (`workflow-test-engine`, `-runner`,
  `-contracts`, `-generator`, `-structure`, `-vendors`, `-instance`) are private
  and bundled into it, and the node descriptions, vendor catalogues and
  test-file schema ship inside it under `data/`. Installing the tarball used to
  fail with E404 on those libraries. `n8n-workflow`, `ajv` and `yaml` remain
  ordinary dependencies. The package has no programmatic API; it no longer
  declares a `main` or a `.` export.
- **Node >= 24 is now required.** The install-level smoke test found that plain
  `npm install` fails on Node 20, because `n8n-workflow` 2.38 pulls in the native
  module `isolated-vm` 7, which supports Node 24 and newer only.
- `WORKFLOW_TEST_DATA=<dir>` overrides where the shipped data is read from
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
- `workflow-test gen` writes by default. It used to write nothing unless
  `WORKFLOW_TEST_MODE=dev`, and told you to run the command you had just run.
  `gen --check` is the read-only form for pre-commit and CI, in every mode.
- `--help` / `-h` is honoured by every command and prints that command's
  usage (`run --help` used to run the suite; `init --help` scaffolded;
  `node-types --help` refused). `workflow-test help <command>` does the same.
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
- Publish-ready package metadata for `workflow-test` (nothing is published yet).

## 0.1.0 — unreleased

Initial public release.
