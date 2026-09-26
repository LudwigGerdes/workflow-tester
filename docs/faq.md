# FAQ and compatibility

## Compatibility

| | Supported |
|---|---|
| n8n | Expressions are evaluated by n8n's own `n8n-workflow` package, version 2.38.1. Tested against n8n 2.38.3 |
| Node descriptions | n8n 2.10.0 ships in the package. `workflow-tester node-types --version <v>` gets any other release |
| Node.js | 24 or newer |

## Questions

### Does it change my workflow?

No. It reads the workflow JSON. It writes only under `.workflow-tester/` and to the `<workflow>.contract.yaml` file next to the workflow.

### Does it need my n8n instance?

No. `run`, `gen` and `explain` work offline. These commands use the network, each behind its own flag:

| Command | Contacts |
|---|---|
| `capture --instance`, `sync` | Your n8n instance |
| `node-types --version` | The npm registry |
| `node-types --instance` | Your n8n instance |
| `contracts update --fetch` | The vendor's published spec |

### Why does a case say "needs a real execution"?

The run reached a node it cannot run offline: an HTTP Request, a node that uses a credential, or a Code node that calls out. Everything before that node was checked. Expectations after it are neither passed nor failed. A [capture](https://workflowtools.dev/workflow-tester/capture) lets the run continue past that node.

### Do Code nodes run?

Yes, in a sandbox, with the same data n8n gives them. They stop when they call out to the network.

### Why `0 passed` with warnings?

A `!` case held every expectation, but an optional field resolved to `undefined`, or an expression reads a field the payload never has. The reason is printed under the case. `--fail-on warn` turns warnings into failures.

### Why does Node.js 20 not work?

n8n's `n8n-workflow` package depends on a native module that supports Node.js 24 and newer only. On Node.js 20, `npx workflow-tester` prints two `EBADENGINE` warnings and exits 1.

### `npm install` warns about install scripts. Is that a problem?

No. The warning names `isolated-vm`, `ssh2` and `cpu-features`. They come with `n8n-workflow`, and workflow-tester never loads them.

## Alternatives

| Alternative | Use it instead when |
|---|---|
| **Test workflow** in n8n | You need the real HTTP calls and credentials to run |
| n8n's expression editor | The expression has a syntax error. workflow-tester is for valid expressions that resolve to `undefined` on a payload you never tried |
| Replaying requests into a running n8n | You want the whole workflow executed end to end |
| Reviewing the JSON by hand | The question is design, not the shape of the data |

## Limitations

- Vendor catalogues exist for GitHub and Stripe only. Any other webhook needs a JSON Schema of its payload (`contracts add --schema`).
- Respond to Webhook in `jwt` or `binary` mode cannot run offline. Every other mode can.
- Pairs of changes are sampled, not exhaustive. A workflow that breaks only when three fields are missing together will not be caught.
- Guards written as `a !== null ? … : …`, or placed inside an enclosing `if` in a Code node, are not recognised. `a?.x`, `a && a.x` and `a ? a.x : b` are.
