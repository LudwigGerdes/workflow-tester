# Generating tests from a payload schema

workflow-tester builds the payloads your workflow is likely to meet from a JSON Schema of what its trigger receives: a field set to `null`, an optional object left out, an empty string. The schema comes from a shipped vendor catalogue (GitHub and Stripe publish one for every webhook they send) or from a JSON Schema file of your own.

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

### Your own schema

For a webhook no catalogue covers, point the contract at a JSON Schema file. Example payloads are optional; each one is checked against the schema before it is kept.

```bash
workflow-tester contracts add workflows/orders.json --schema schemas/order-created.json --examples schemas/samples
```

**Expected output:**

```text
workflows/orders.contract.yaml
  schema  ../schemas/order-created.json @ sha256:3f1c9a2b7d40
  events  order-created
  shape   ../.workflow-tester/contracts/schema.order-created.schema.json
```

The contract it writes:

```yaml
version: 1
trigger: Webhook
source:
  kind: schema
  schema: ../schemas/order-created.json
  examples: ../schemas/samples
shape:
  schema: ../.workflow-tester/contracts/schema.order-created.schema.json
  examples: ../.workflow-tester/contracts/schema.order-created.examples.json
```

| Key | Takes |
|---|---|
| `schema` | A `.json`, `.yaml` or `.yml` JSON Schema file, relative to the contract |
| `examples` | A directory of `.json` files, one payload each, or one `.json` file holding a payload or a list of them |
| `name` | The event name cases are tagged with. Defaults to the schema file's name |

The schema is copied into the shape, so `contracts update` after editing the source file refreshes it, and the version shown is a digest of the schema. Payloads arrive with `content-type: application/json` and no vendor headers.

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
