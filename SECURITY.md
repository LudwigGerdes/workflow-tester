# Security

## Reporting a vulnerability

Report privately through GitHub's **Report a vulnerability** button on the
[Security tab](https://github.com/LudwigGerdes/workflow-tester/security/advisories/new)
of this repository. Please do not open a public issue for anything that could
be exploited before it is fixed.

Expect an acknowledgement within about a week. There is no bug bounty.

## What handles secrets

workflow-tester is offline by design. Four commands can reach the network, each only
behind its own flag, and two of them carry a credential:

| Command | Network | Credential |
|---|---|---|
| `capture --instance <url>` | that n8n instance, read-only | `N8N_API_KEY` |
| `sync` | that n8n instance, read-only | `N8N_API_KEY` |
| `node-types --version <v>` | npm registry, read-only | none |
| `node-types --instance <url>` | that instance's start page, unauthenticated | none |
| `contracts update --fetch` (and `pnpm ingest`) | the vendor's published spec | none |

The API key is read from the environment only — it is never accepted as a
command-line argument, because an argument lands in shell history and the
process list — held in memory, and sent as the `X-N8N-API-KEY` header to the
instance named by `--instance` or `N8N_API_URL`. Nothing writes the key to
disk. The files workflow-tester creates are: `.workflow-tester/` in your repository
(contracts, generated cases, tests, and the gitignored last report),
`<workflow>.contract.yaml` beside a workflow, and the caches under
`~/.workflow-tester/` (`WORKFLOW_TESTER_CACHE` moves them) holding vendor specs and extracted
node descriptions. A capture records field names and types, never values.

`gen`, `run`, `explain`, `schema`, `init`, `promote`, `vendors` and
`node-types --list|--from` make no network request and need no credential.

## Supported versions

Only the latest release on `main` receives fixes.
