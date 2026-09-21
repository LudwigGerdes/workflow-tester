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

## Code nodes

Code nodes run in a sandbox with the same data n8n gives them. A Code node that calls out, for example with `$helpers.httpRequest`, stops the run at that node.

## Let an AI write them

```bash
workflow-tester schema > test.schema.json
```

Give the schema to a model and ask it for test cases. The schema is exact, and a file with an unknown key is rejected with the line number.
