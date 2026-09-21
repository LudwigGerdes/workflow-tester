# Running workflow-tester without remembering to

A test suite you have to remember to run is a suite that stops being run. Two
surfaces, one engine, and neither asks a question — a hook that stops to prompt
blocks the commit and gets uninstalled.

## Pre-commit

Copy `scripts/workflow-tester.sh` into the repository holding your workflows, point
`WORKFLOW_TESTER_HOME` at this checkout, and install the hook:

```bash
export WORKFLOW_TESTER_HOME=/path/to/workflow-tester        # required once the script is copied out
npx lefthook install
```

`lefthook.yml` here is the reference. It runs two things on commit:

- **`gen --check`** writes nothing and fails when the committed cases no longer
  match their contracts. Regenerating (`workflow-tester gen`) is a deliberate act rather
  than something a hook does behind your back.
- **`run`** is the gate. It fails only on a broken expression — the
  workflow succeeding while its data is wrong, which is the bug this exists to
  catch.

Without the checkout the script prints one line and exits 0. A developer who
never asked for this should still be able to commit.

## Capturing tests from runs you already made

Nobody hand-writes cases for a workflow they built by dragging boxes, so the
suite goes stale. Capture turns a run that already happened into the test:

```bash
workflow-tester capture workflows/invoice.json --execution export.json
```

Only **shape** is recorded — which fields exist and what type each holds. No
values reach disk, so the capture is safe to commit, and shape is the only part
that survives promotion anyway: dev and production hold different records with
the same structure.

The capture lands in `workflows/invoice.contract.yaml`, beside the workflow, so
promotion moves both. Nothing needs to know workflow-tester exists.

### When to capture

On push, for workflows that are **active**. Pushing is the signal that the work
is done; watching every execution would collect half-broken debug runs alongside
the real ones, and activation is the filter rather than the trigger.

Capture reaches back for the most recent execution rather than waiting for one.
An activated workflow has none at the moment it is activated — the first arrives
shortly after — so with nothing to read yet, record that and try again later:

```bash
workflow-tester capture workflows/invoice.json --awaiting
```

That is deliberately not an empty capture, which would read as "ran, produced
nothing".

### Drift

Capturing again over an existing record reports what moved:

```
invoice.json: 1 node(s) changed shape
  Format Customer
    removed  customer.tier  string is no longer produced
  re-run with --update to accept
```

A field that stopped being produced is the dangerous one: whatever reads it
downstream now resolves to undefined, and n8n swallows that silently. It is
reported rather than failed — a suite that fails on every legitimate edit gets
regenerated unread, and then it is catching nothing — and the record is never
replaced without `--update`. A rename is followed by node id, so renaming a node
is not mistaken for deleting it.

## What a capture buys beyond drift

A node the engine cannot run — an HTTP call, anything credentialed, a Code node
that reaches outside itself — used to end the walk, leaving everything after it
unverified. With a capture, the engine substitutes a stand-in built from the
recorded shape and carries on. One unrunnable node costs you that node, not the
rest of the workflow.

The report says so plainly:

```
stood in for 1 node from a recorded capture: Call API
  their own behaviour is unverified; what reads them downstream is not
```

Values in a stand-in are invented from the shape. Expressions that *read* a
field are verified; expressions that branch on its *value* are not. A green run
that quietly rested on stand-ins would claim more than it checked.

## Catching a repo that has drifted from its instance

`workflow-tester sync --once` exits 1 when the instance has run a workflow more recently
than its committed capture records. On a schedule, that is how you find out that
a workflow changed under you before a test does.
