# Capturing execution fixtures

The engine reimplements the semantics of a handful of expression-pure nodes.
That reimplementation is only trustworthy if it reproduces what n8n actually
does, so every pure node kind is proven against **real execution exports** —
never against hand-written expectations.

> **Real exports only.** Do not hand-write or "reconstruct" execution JSON. A
> fabricated fixture proves that the engine agrees with its author, which is
> exactly the thing under test.

Exports are committed under `packages/engine/test/fixtures/executions/<name>.json`
and are the body of `GET /api/v1/executions/:id?includeData=true`, with only
the redactions listed in that directory's `README.md` applied.

## 1. A throwaway n8n in Docker

Semantics fixtures must come from **n8n 2.10.0** — the version
`SUPPORTED_N8N_VERSION` and the bundled node descriptions are pinned to.
Semantics drift between minors, so an export from another build silently
encodes the wrong ground truth. (The error-branch set was captured separately
from a 2.38.x instance; see the fixtures README.)

Start a disposable container. Nothing on it survives the capture, so the
credentials below are throwaway by design:

```bash
docker run -d --name payload-contract-fixtures -p 5680:5678 \
  -e N8N_DIAGNOSTICS_ENABLED=false \
  n8nio/n8n:2.10.0
docker exec payload-contract-fixtures n8n --version    # must print 2.10.0
```

Confirm nothing else already answers on the host port before trusting it —
another n8n bound to the same port produces a confusing mix of `/healthz`
answering and `/rest/*` returning 404:

```bash
lsof -nP -iTCP:5680 -sTCP:LISTEN
```

If the port is contested, address the container directly instead:

```bash
docker exec payload-contract-fixtures sh -c 'wget -qO- http://localhost:5678/rest/settings'
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' payload-contract-fixtures
```

Confirm the public API is on: `/api/v1/executions` must answer **401**
(enabled, needs a key), not 404 (disabled).

## 2. An API key

The public API authenticates with `X-N8N-API-KEY`. On a fresh container you can
create everything over HTTP, no browser needed:

```bash
# owner account (throwaway; this instance is disposable)
curl -s -c /tmp/cookie -X POST http://localhost:5680/rest/owner/setup \
  -H 'Content-Type: application/json' \
  -d '{"email":"fixtures@payload-contract.local","firstName":"Fixture","lastName":"Capture","password":"Throwaway-local-1"}'

# scopes must be real names, so ask for the list, then request all of them
curl -s -b /tmp/cookie http://localhost:5680/rest/api-keys/scopes
curl -s -b /tmp/cookie -X POST http://localhost:5680/rest/api-keys \
  -H 'Content-Type: application/json' \
  -d '{"label":"fixtures","expiresAt":null,"scopes":[…]}'
```

**Use `rawApiKey` from the response, not `apiKey`.** `apiKey` is masked
(`******OgBA`) and gives 401; `rawApiKey` is the usable JWT.

```bash
export KEY=<rawApiKey>
```

## 3. Build the fixture workflows

The engine seeds exactly one trigger item, and it stops at the first node it
does not interpret — so a fixture has to reach the nodes under test through
pure ones only. The pattern that satisfies both:

```
Manual Trigger → Seed (Set, raw mode, emitting an array)
               → Split Out (fan to N items)
               → [ node under test, node under test, … ]   ← parallel branches
```

Fanning out means one execution yields a fixture for every node on it, each
receiving identical input. Multi-item input matters: several of the engine's
claims are about `pairedItem`, which a single-item run cannot distinguish.
Merge needs two Split Out branches feeding inputs 0 and 1.

Create over the API, then execute through the container's CLI:

```bash
curl -s -H "X-N8N-API-KEY: $KEY" -H 'Content-Type: application/json' \
  -X POST http://localhost:5680/api/v1/workflows -d @wf.json

docker exec -e N8N_RUNNERS_BROKER_PORT=5799 -e N8N_RUNNERS_ENABLED=false \
  payload-contract-fixtures n8n execute --id <workflowId>
```

**Both env overrides are required.** `n8n execute` inside a container that is
already serving will otherwise fail with "n8n Task Broker's port 5679 is
already in use", because the CLI tries to start its own broker on the port the
running instance holds.

### What is already captured

| Fixture | Covers |
|---|---|
| `item-nodes.json` | Set (raw), Split Out, Sort, Limit, Aggregate, Remove Duplicates, Rename Keys |
| `routing-and-set.json` | IF, Filter, Switch (with an `extra` fallback), Set (manual: coercion, dotted nesting, includeOtherFields) |
| `merge.json` | Merge append, combine-by-position, chooseBranch |
| `pass-through.json` | NoOp, Set with `dotNotation: false` (a literal `a.b` key), IF under loose type validation |
| `success-run.json`, `error-run.json`, `multi-run.json` | a clean run, a failed run, and a node that ran three times in a loop |
| `error-output-taken.json`, `error-output-not-taken.json`, `stop-and-error.json`, `unhandled-failure.json` | the endings a workflow can have (see the fixtures README) |

That is every interpreted node kind. A new node kind is not done until it
appears here.

## 4. Export

```bash
curl -s -H "X-N8N-API-KEY: $KEY" \
  "http://localhost:5680/api/v1/executions/<id>?includeData=true" \
  > packages/engine/test/fixtures/executions/<name>.json
```

Keep the response as returned, apart from the redactions the fixtures README
lists (proxy headers, tokens, hostnames, instance ids). Never touch anything
under `runData` output, `executionStatus`, `source` or `error` — that is what
the replay compares.

`test/execution-fixtures.test.ts` discovers every file in that directory,
reconstructs an `EngineInput` from `workflowData` plus what the trigger
actually emitted, walks it, and compares each interpreted node's outputs
against the real ones — `pairedItem` included.

## 5. When a fixture disagrees

The export wins. Fix the semantics, and land the fix as its own commit naming
the divergence, so the history records what n8n actually does and where we had
guessed wrong.

## 6. Clean up

```bash
docker rm -f payload-contract-fixtures
```
