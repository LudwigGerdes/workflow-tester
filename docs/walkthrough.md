# Walkthrough: what payload-contract generates for a new workflow

Run end to end against an n8n 2.38.3 instance, with a workflow created and
published for the purpose and deleted afterwards. Commands assume
`payload-contract` resolves to `node packages/cli/dist/bin.js` in a built checkout
(see the README).

## The workflow

A GitHub issue-triage webhook, three nodes:

    Webhook ──▶ Is Opened? (IF) ──▶ Build Triage Record (Set)

`Is Opened?` compares `$json.body.action` to `"opened"`. `Build Triage Record`
assigns four fields:

| field | expression |
|---|---|
| `title` | `$json.body.issue.title` |
| `reporter` | `$json.body.issue.user.login` |
| `assignee` | `$json.body.issue.assignee.login` |
| `repo` | `$json.body.repository.full_name` |

One defect was planted deliberately: GitHub's schema makes `issue.assignee`
nullable, and the workflow reads `.login` off it unconditionally.

## The commands, in order

```bash
# 1. scaffold, recording which n8n release these workflows run on
payload-contract init --n8n-version 2.38.3
#    → .payload-contract/tests/example.test.yaml, .payload-contract/README.md, .payload-contract/config.yaml

# 2. say what the trigger can receive
payload-contract contracts add workflows/issue-triage.json --vendor github --events issues-opened
#    → workflows/issue-triage.contract.yaml
#    → .payload-contract/contracts/github.issues-opened.{schema,examples}.json

# 3. generate the cases (--max raises the default budget of ~3.5 per node)
payload-contract gen --max 200
#    → 200 cases under .payload-contract/cases/issue-triage/github.issues-opened/
#      "200 added, 0 retired, 0 unchanged (capped, 1120 discarded)"

# 4. run them
payload-contract run

# 5. read one failure as a paste-ready test file
payload-contract explain 11df5e3da2dee888

# 6. optional: match the instance's own n8n version exactly
payload-contract node-types --instance https://your-n8n
payload-contract node-types --list
```

## What it generated

1120 candidate variants, capped to 200 committed cases. They are named for the
mutation that produced them, and fall into three families:

- **`nullable-null <path>`** — a field the schema allows to be null, set to null.
- **`optional-absent <path>`** — an optional field removed entirely.
- **`format-edge <path> (empty|unicode)`** — a string at its format boundary.

Plus one `example #0 (issues-opened)` taken from the vendor's own published
example. Cases combine mutations in pairs, e.g.
`format-edge body.issue.title (unicode) + nullable-null body.issue.user`.

Case ids are content hashes (`11df5e3da2dee888`), one JSON file each, with an
`index.json` beside them. 200 cases came to 3.2 MB.

## What it found

`193 passed, 7 failed, 1 warned`:

| finding | cases | what it means |
|---|---|---|
| `assignment "assignee" resolved to undefined` | 1 fail | the planted bug: `issue.assignee` is nullable |
| same, on `optional-absent` | 1 warn | absent rather than null — a warning, not a failure |
| `assignment "reporter" resolved to undefined` | 5 fail | **not planted**: `issue.user` is nullable too |

The second finding is the interesting one. `issue.user` being nullable is not
something you would think to check, and five separate variant combinations
reached it.

`explain` prints the failing case as a complete test file, including the payload
that produced it — the `body.issue.assignee: null` is visible directly in it.

## Version matching

With `n8nVersion: 2.38.3` pinned and only 2.10.0 bundled, the run appended:

    note: n8n 2.38.3 is not bundled; using the nearest older 2.10.0

After `node-types --instance`, `--list` reported `a run would use: extracted
2.38.3` and the note disappeared. The expression failures were identical either
way, which is correct: they do not depend on node descriptions.
