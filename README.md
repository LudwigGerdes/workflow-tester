# workflow-tester

[![CI](https://github.com/LudwigGerdes/workflow-tester/actions/workflows/ci.yml/badge.svg)](https://github.com/LudwigGerdes/workflow-tester/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/workflow-tester.svg)](https://www.npmjs.com/package/workflow-tester)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Find the payloads that break your n8n workflow before someone sends them. When a webhook arrives with a field set to `null` or an optional object missing, n8n turns the broken expression into `undefined` and shows no error. workflow-tester runs your workflow's expressions against those payloads and tells you which ones break and where. It runs offline, with no n8n instance.

![workflow-tester finding an expression that resolves to undefined, then passing after a one-line fix](https://raw.githubusercontent.com/LudwigGerdes/workflow-tester/main/docs/demo/quickstart.gif)

## Installation

Requires Node.js 24 or newer.

Run it without installing:

```bash
npx workflow-tester --help
```

Add it to a project:

```bash
npm install --save-dev workflow-tester
```

Build from source:

```bash
git clone https://github.com/LudwigGerdes/workflow-tester.git
cd workflow-tester
pnpm install && pnpm build
```

## Getting started

Set up a project:

```bash
npx workflow-tester init
```

This creates:

```text
.workflow-tester/
├── README.md
└── tests/
    └── example.test.yaml
```

Download a sample sign-up workflow and a test file with three cases, then run them:

```bash
curl -L --create-dirs -o workflows/signup.json https://raw.githubusercontent.com/LudwigGerdes/workflow-tester/main/docs/demo/signup.json
curl -L -o .workflow-tester/tests/signup.test.yaml https://raw.githubusercontent.com/LudwigGerdes/workflow-tester/main/docs/demo/signup.test.yaml
npx workflow-tester run
```

**Expected output:**

```text
workflows/signup.json
  ✗ no profile object, flat name — the ?? gotcha  1 expectation(s) fail
      ✗ node.Normalize.output[0].json.name: expected "Bob", got undefined
      ! "profile" is not produced here  at Normalize → assignments.assignments[1].value
      ! "plan" is not produced here  at Normalize → assignments.assignments[2].value
  ! no email at all  every expectation held
      ! "email" is not produced here  at Normalize → assignments.assignments[0].value
      ! "profile" is not produced here  at Normalize → assignments.assignments[1].value
      ! "plan" is not produced here  at Normalize → assignments.assignments[2].value
      ! "email" is not produced here  at Normalize → assignments.assignments[3].value
  ✓ pro user with nested profile

1 passed, 1 failed, 1 warned in 354ms
```

The first case fails because the workflow reads `$json.body.profile.first_name` when there is no `profile`.

## Usage

Write a test by hand, in `.workflow-tester/tests/`:

```yaml
workflow: ../../workflows/signup.json
cases:
  - id: flat-name
    when:
      trigger: webhook
      payload:
        email: bob@example.com
        name: Bob
    then:
      node.Normalize.output[0].json.name: Bob
```

Run every test:

```bash
workflow-tester run
```

Generate tests from the payloads GitHub or Stripe can send:

```bash
workflow-tester contracts add workflows/issue-triage.json --vendor github --events issues-opened
workflow-tester gen
workflow-tester run --only generated
```

Turn a run you already made in n8n into a test:

```bash
workflow-tester capture workflows/invoice.json --execution execution.json
```

Report in a format your CI understands:

```bash
workflow-tester run --format junit
```

## Documentation

Full documentation is at [workflowtools.dev/workflow-tester](https://workflowtools.dev/workflow-tester/):

- [Command line](https://workflowtools.dev/workflow-tester/cli)
- [Writing tests](https://workflowtools.dev/workflow-tester/writing-tests)
- [Generating tests from GitHub and Stripe payloads](https://workflowtools.dev/workflow-tester/generated-tests)
- [Capturing real runs](https://workflowtools.dev/workflow-tester/capture)
- [Pre-commit and CI](https://workflowtools.dev/workflow-tester/ci)
- [FAQ and compatibility](https://workflowtools.dev/workflow-tester/faq)

## License

[MIT](LICENSE) © Ludwig Gerdes

Bundled n8n node descriptions and the GitHub and Stripe payload catalogues are covered by [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Not affiliated with n8n GmbH, GitHub or Stripe.
