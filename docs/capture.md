# Capturing real runs

`capture` turns a run you already made in n8n into a test. It records the shape of what each node produced: which fields exist and what type each one has.

> [!NOTE]
> No values are written to disk, only field names and types. A capture is safe to commit.

## From a saved execution

Save one execution from n8n's API to a file:

```bash
curl -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.example.com/api/v1/executions/1234?includeData=true" > execution.json
```

Then capture it:

```bash
workflow-tester capture workflows/invoice.json --execution execution.json
```

The capture is stored in `workflows/invoice.contract.yaml`, next to the workflow.

## From your n8n instance

```bash
export N8N_API_KEY=…
workflow-tester capture workflows/invoice.json --instance https://n8n.example.com
```

This takes the newest execution of that workflow.

- The API key is read from `N8N_API_KEY` only. It is never accepted as an argument, because arguments end up in shell history.
- The URL comes from `--instance` or `N8N_API_URL`.

## When the shape changes

Capturing again compares the new run with the stored one.

**Expected output:**

```text
invoice.json: 1 node(s) changed shape
  Format Customer
    removed  customer.tier  string is no longer produced
  re-run with --update to accept
```

| Flag | Effect |
|---|---|
| `--update` | Accept the new shape and replace the stored one |
| `--awaiting` | Record a workflow that is active but has not run yet |
| `--workflow <id>` | Pick the workflow on the instance by id |

A removed field is the one to look at first. Whatever reads it later in the workflow now gets `undefined`.

`capture` reports a change and exits 0. Use `sync --once` when you want a change to fail a job.

## Running past nodes that cannot run offline

An HTTP Request node cannot run offline, so a test normally stops there. With a capture, workflow-tester uses that node's recorded shape and carries on. The report says how many nodes were stood in for, for example `stood in for 1 node from pinData or a recorded capture`.

## Keeping captures up to date

```bash
workflow-tester sync --once            # one pass; exits 1 when a capture is behind
workflow-tester sync --interval 2m     # keep watching
```

| Setting | Effect |
|---|---|
| `WORKFLOW_TESTER_MODE=dev` | A newer execution is recorded instead of reported |
| unset | A newer execution is reported only |

`WORKFLOW_TESTER_MODE` only affects `capture` and `sync`. It never changes what counts as a passing test.
