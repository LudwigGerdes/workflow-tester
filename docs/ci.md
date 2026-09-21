# Pre-commit and CI

Two commands do the work in both places.

| Command | Fails when |
|---|---|
| `workflow-tester gen --check` | The committed generated cases no longer match their contracts. It writes nothing |
| `workflow-tester run` | A test fails |

## Pre-commit with lefthook

Add this to `lefthook.yml` in the repository that holds your workflows, then run `npx lefthook install`.

```yaml
pre-commit:
  commands:
    workflow-tests-current:
      run: npx workflow-tester gen --check
    workflow-tests:
      run: npx workflow-tester run
```

When `gen --check` fails, run `workflow-tester gen` and commit the result.

## GitHub Actions

```yaml
name: workflow tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npx workflow-tester gen --check
      - run: npx workflow-tester run --format github-actions
```

`--format github-actions` puts each failure on the pull request as an annotation.

### GitHub code scanning

```yaml
      - run: npx workflow-tester run --format sarif > workflow-tester.sarif
        continue-on-error: true
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: workflow-tester.sarif
```

SARIF results point at the workflow file, not at a line in it.

## Other CI systems

```bash
npx workflow-tester run --format junit > results.xml
```

## Checking captures on a schedule

If you use [captures](https://workflowtools.dev/workflow-tester/capture), `sync --once` exits 1 when your n8n instance has run a workflow more recently than its committed capture.

```yaml
      - run: npx workflow-tester sync --once --instance https://n8n.example.com
        env:
          N8N_API_KEY: ${{ secrets.N8N_API_KEY }}
```
