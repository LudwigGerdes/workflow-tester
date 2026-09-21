# workflow-test-paths

`dataDir(kind)`: the one function that knows where workflow-test's shipped data lives — the committed files in a checkout, `data/<kind>` inside the installed package, or `WORKFLOW_TEST_DATA/<kind>` when set.

Part of [workflow-test](https://github.com/LudwigGerdes/workflow-test), which generates and runs contract tests from the payloads a workflow trigger can receive. n8n is the first supported platform. This is an internal workspace library: it is not published on its own, and is bundled into the one published package, `workflow-test`.

MIT licensed. Not affiliated with n8n GmbH.
