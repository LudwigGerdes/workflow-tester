# Execution fixtures

Real n8n execution exports, captured verbatim from `GET /api/v1/executions/:id?includeData=true`.
Nothing here is hand-written: the point of these files is that they are what n8n
actually produced, so the engine's semantics are checked against reality rather
than against our belief about it.

## Error-branch set (captured from n8n 2.38.x)

Four exports covering the endings a workflow can have. They exist because
outcome classification cannot be designed from the reshaped view an MCP client
returns — that view drops `executionStatus` and `source`, and reports a handled
error as a plain success.

| File | What it captures | Key detail |
|---|---|---|
| `error-output-taken.json` | a node with `onError: continueErrorOutput` that threw | node `executionStatus` is **success**; `main` is `[[], [item]]` |
| `error-output-not-taken.json` | the same node succeeding | `main` is `[[item], []]` |
| `stop-and-error.json` | a `Stop and Error` terminus | node `executionStatus` **error**, no `main`; `resultData.error.node` names it |
| `unhandled-failure.json` | a Code node throwing with no error output | node `executionStatus` **error**, no `main`; `resultData.error` has **no** `node` |

What they establish:

- A handled error is a *successful* execution, at both node and run level. Which
  branch ran is legible only from the output index, never from status.
- `Stop and Error` and an unhandled throw are identical on status. The
  discriminator is the node's **type** in the workflow JSON.
- `lastNodeExecuted` names the terminal node in every case.
- An errored node has no `data.main` at all, rather than an empty array.

**What was edited, and nothing else.** These came off an instance behind a
reverse proxy, so they arrived carrying things that should not be published:

- client-address and request-id headers the proxy added (`x-forwarded-for`,
  `x-real-ip`, `x-request-start`, and the like), plus `user-agent` →
  `redacted`; the proxy's own edge/region headers were dropped
- `resumeToken` → `redacted` (a 64-hex n8n token, one per file)
- the instance hostname → `n8n.example`, in the `host` header and `webhookUrl`
- `workflowId`, `workflowVersionId` and `webhookId` → synthetic values
  (`wf-fixture-NNNN`, `00000000-0000-4000-8000-0000000000NN`), applied
  consistently across each file

Nothing under `runData` output, `executionStatus`, `source` or `error` was
touched, which is what the replay actually checks. The hostname appears on both
sides of that comparison — it is the trigger's own output — so replacing it
consistently leaves the check intact.

These are therefore *redacted* captures rather than untouched ones. That is a
real if small loss: the point of a fixture is being what n8n produced. Anything
that would change the engine's verdict was left exactly as it came.
