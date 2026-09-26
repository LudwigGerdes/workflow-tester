# Writing tests

Tests live in `.workflow-tester/tests/*.test.yaml`.

```yaml
workflow: ../../workflows/signup.json
cases:
  - id: flat-name
    title: no profile object, flat name
    when:
      trigger: webhook
      payload:
        email: bob@example.com
        name: Bob
    then:
      execution.status: success
      node.Normalize.output[0].json.name: Bob
      node.Respond Free.items: 1
```

## The parts of a case

| Key | Meaning |
|---|---|
| `workflow` | Path to the workflow JSON, relative to the test file |
| `id` | Unique within the file. Results are reported by it |
| `title` | Optional. Shown in the report |
| `when.trigger` | `webhook` or `manual`, or `{ node: <Trigger node name> }` to start from a named trigger |
| `when.payload` | The request body. workflow-tester wraps it the way a Webhook node delivers it, so `$json.body.…` works as it does in n8n |
| `given.pinData` | Items a node is taken to have produced, so the run carries on past a node that calls out. See below |
| `then` | What you expect. See below |

A file with one case can put `when` and `then` at the top level and leave out `cases`.

## Expectations

| Expectation | Checks |
|---|---|
| `execution.status: success` | How the run ended |
| `node.<Node name>.output[0].json.<path>: value` | A field in a node's output |
| `node.<Node name>.items: 1` | How many items a node produced |

Keys are flat and dotted. Use the node's name exactly as it appears on the canvas, spaces included.

## The mistake this finds first

n8n turns an expression error into `undefined` and reports nothing.

```text
{{ $json.body.profile.first_name ?? $json.body.name }}     still undefined
{{ $json.body.profile?.first_name ?? $json.body.name }}    works
```

When `profile` is missing, reading `.first_name` from it throws. n8n swallows the whole expression, the `??` fallback included. Optional chaining (`?.`) avoids the throw, so the fallback runs.

## Nodes that call out

An HTTP Request node, a credentialed node or a Code node that calls out stops the run: its output is only knowable by running it for real. `given.pinData` supplies that output, the way pinning does in the n8n editor, so everything after the node is still checked.

```yaml
workflow: ../../workflows/enrich.json
given:
  pinData:
    Fetch Plan:
      - json: { plan: pro, seats: 5 }
cases:
  - id: pro-plan
    when:
      trigger: webhook
      payload: { customer: c_1 }
    then:
      node.Route.output[0].json.tier: paid
  - id: free-plan
    given:
      pinData:
        Fetch Plan:
          - json: { plan: free, seats: 1 }
    when:
      trigger: webhook
      payload: { customer: c_2 }
    then:
      node.Route.output[0].json.tier: free
```

Keys are node names; values are the items the node produced, in n8n's `{ json: … }` form. A file-level `given` applies to every case, and a case's own pins win. The report lists the nodes that were stood in for. A `capture` of a real execution supplies the same thing for every case without writing it out.

`given.snapshot`, `packs`, `seed` and `faults` describe a mock and are refused until that support lands.

## Code nodes

Code nodes run in a sandbox with the same data n8n gives them. A Code node that calls out, for example with `$helpers.httpRequest`, stops the run at that node.

## Let an AI write them

```bash
workflow-tester schema > test.schema.json
```

Give the schema to a model and ask it for test cases. The schema is exact, and a file with an unknown key is rejected with the line number.
