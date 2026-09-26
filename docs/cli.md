# Command line

| Command | What it does |
|---|---|
| `workflow-tester init [--n8n-version <v>] [--no-ask]` | Create `.workflow-tester/` with a commented example test |
| `workflow-tester run [<workflow.json>] [--only generated\|tests] [--format <f>] [--fail-on warn] [--concurrency N]` | Run every test |
| `workflow-tester contracts add <workflow.json> --vendor <v> --events <a,b> [--trigger <name>]` | Say which vendor events a workflow's trigger receives |
| `workflow-tester contracts add <workflow.json> --schema <file> [--examples <path>] [--name <n>] [--trigger <name>]` | Use a JSON Schema of your own as the trigger's payload |
| `workflow-tester contracts update [<workflow.json>...] [--all] [--fetch] [--vendor <v>]` | Refresh contracts from the vendor catalogues and schema files |
| `workflow-tester gen [<workflow.json>...] [--max N] [--check]` | Generate test cases from each contract |
| `workflow-tester explain <caseId>` | Print a case as a test file, with the result of its last run |
| `workflow-tester promote <caseId> [--name <file>]` | Copy a generated case into a hand-written test |
| `workflow-tester capture <workflow.json> --execution <file.json> \| --instance <url>` | Record the shape of what each node produced in a real run |
| `workflow-tester sync [--instance <url>] [--interval 30s] [--once]` | Compare every capture against your n8n instance |
| `workflow-tester vendors list` | List vendors and how many events each covers |
| `workflow-tester vendors events <vendor>` | List the event names `contracts add --events` accepts |
| `workflow-tester node-types --version <v> \| --instance <url> \| --from <dir> \| --list` | Get the node descriptions for your n8n version |
| `workflow-tester schema` | Print the JSON Schema for a test file |
| `workflow-tester --version` | Print the version |

`workflow-tester <command> --help` prints one command's usage.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean |
| `1` | A test failed. With `--fail-on warn`, a warning also counts |
| `2` | Usage or configuration error |

## Reading the results

| Mark | Meaning |
|---|---|
| `✓` | Every expression resolved and every expectation held |
| `✗` | An expectation failed, or an expression broke |
| `!` | A warning: an optional field resolved to `undefined`, or an expression reads a field the payload never has |

The reason is printed under each case, with the node and the parameter it came from.

Some cases end with **needs a real execution**. The run reached a node it cannot run offline, such as an HTTP Request or a node that uses a credential, and stopped there. Everything before that node was checked. A [capture](https://workflowtools.dev/workflow-tester/capture) lets the run continue past it.

## Report formats

```bash
workflow-tester run --format junit > results.xml
```

| `--format` | Use it for |
|---|---|
| `stylish` | Reading at a terminal. The default |
| `json` | Scripts |
| `junit` | GitLab and most CI runners |
| `sarif` | GitHub code scanning |
| `github-actions` | Inline annotations on a pull request |

## Files in your project

```text
workflows/
├── invoice-sync.json
└── invoice-sync.contract.yaml      the contract, and any capture
.workflow-tester/
├── config.yaml                     your n8n version
├── contracts/                      payload schemas and examples
├── cases/                          generated tests
├── tests/                          tests you wrote
└── reports/                        the last run
```

Commit everything except `.workflow-tester/reports/`.

## Matching your n8n version

workflow-tester ships node descriptions for n8n 2.10.0, so it works offline straight after install. To match your instance:

```bash
workflow-tester node-types --version 2.38.3                     # download once from the npm registry
workflow-tester node-types --instance https://n8n.example.com   # ask the instance which version it runs
workflow-tester node-types --from ./my-custom-nodes             # custom nodes, offline
workflow-tester node-types --list
```

Then put the version in `.workflow-tester/config.yaml`:

```yaml
n8nVersion: 2.38.3
```

- Downloaded descriptions are stored in `~/.workflow-tester/node-types/`. Set `WORKFLOW_TESTER_CACHE` to move that folder.
- When the pinned version and the descriptions in use differ, the run says so, and a missing required parameter becomes a warning instead of a failure. Expressions and Code nodes do not depend on the descriptions.
