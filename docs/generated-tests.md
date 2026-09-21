# Generating tests from GitHub and Stripe payloads

GitHub and Stripe publish a schema for every webhook they send. workflow-tester uses those schemas to build the payloads your workflow is likely to meet: a field set to `null`, an optional object left out, an empty string.

## 1. Add a contract

A contract says which events a workflow's trigger receives.

```bash
workflow-tester contracts add workflows/issue-triage.json --vendor github --events issues-opened
```

**Expected output:**

```text
workflows/issue-triage.contract.yaml
  vendor  github @ 1.1.4
  events  issues-opened
  shape   ../.workflow-tester/contracts/github.issues-opened.schema.json
```

This creates:

```text
workflows/
└── issue-triage.contract.yaml
.workflow-tester/
└── contracts/
    ├── github.issues-opened.examples.json
    └── github.issues-opened.schema.json
```

The sample workflow is [`docs/demo/issue-triage.json`](https://github.com/LudwigGerdes/workflow-tester/blob/main/docs/demo/issue-triage.json).

### Event names

| Vendor | Names look like | Example |
|---|---|---|
| GitHub | The event plus its action | `issues-opened`, `pull-request-opened` |
| Stripe | Stripe's own names | `invoice.paid`, `charge.refunded` |

List a vendor's event names with `workflow-tester vendors events github`. A wrong name is rejected before anything is written, and the error lists the names that exist.

![contracts add rejecting an unknown event and succeeding on retry](https://raw.githubusercontent.com/LudwigGerdes/workflow-tester/main/docs/images/workflow-tester-3.png)

### The contract file

```yaml
version: 1
trigger: Webhook
source:
  kind: vendor
  vendor: github
  events:
    - issues-opened
shape:
  schema: ../.workflow-tester/contracts/github.issues-opened.schema.json
  examples: ../.workflow-tester/contracts/github.issues-opened.examples.json

# overrides:
#   required: []
#   never: []
#   only: []
```

`overrides` is the only part you edit by hand.

| Override | Takes | Effect |
|---|---|---|
| `required` | Paths | Never leave these fields out, even when the schema says they are optional |
| `never` | Paths | Leave these fields, and everything under them, unchanged |
| `only` | Event names | Generate cases for these events only |

Paths are dotted, with `[]` for every element of an array and `[n]` for one.

## 2. Generate the cases

```bash
workflow-tester gen
```

**Expected output:**

```text
workflows/issue-triage.json → github.issues-opened: 14 case(s) — 14 added, 0 retired, 0 unchanged (budget 14 for 4 nodes, 486 discarded)
```

Cases are written to `.workflow-tester/cases/`. Commit them.

- The same contract and workflow always produce identical files.
- `gen --check` writes nothing and exits 1 when the cases are out of date. Use it in pre-commit and CI.
- `--max N` changes how many cases are kept.

### What gets generated

Each case is a real vendor example with one or two things changed.

| Kind | Change |
|---|---|
| `optional-absent` | An optional field is left out |
| `nullable-null` | A nullable field is `null` |
| `oneOf-branch` | Another branch of a `oneOf` |
| `enum-value` | Another allowed value |
| `array-cardinality` | An empty array, or one with several items |
| `format-edge` | An empty string, unicode, `0`, `-1`, a very large number |

Only fields your workflow reads are varied.

## 3. Run them

```bash
workflow-tester run --only generated
```

![run --only generated on GitHub issue payloads](https://raw.githubusercontent.com/LudwigGerdes/workflow-tester/main/docs/images/workflow-tester-2.png)

On the sample workflow this ends with `10 passed, 3 failed, 1 warned`. The workflow reads `issue.assignee.login`, and GitHub sends `assignee: null` when nobody is assigned. It also finds that `issue.user` can be `null`.

## Keep a failing case

```bash
workflow-tester explain 11df5e3da2dee888
workflow-tester promote 11df5e3da2dee888 --name missing-assignee
```

| Command | What it does |
|---|---|
| `explain <caseId>` | Prints the case as a complete test file, payload included, with the result of its last run |
| `promote <caseId>` | Copies the case into `.workflow-tester/tests/` with a `then:` block to fill in, and stops `gen` from retiring it |

## Supported vendors

```bash
workflow-tester vendors list
```

**Expected output:**

```text
vendor    coverage       spec version          events
github    schema         1.1.4                 10 of 270
stripe    schema         2026-08-26.dahlia     7 of 265
slack     nothing        —                     —
```

Slack publishes no schema for its event payloads. For Slack, or for a webhook of your own, [write tests by hand](https://workflowtools.dev/workflow-tester/writing-tests).
