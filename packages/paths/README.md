# payload-contract-paths

`dataDir(kind)`: the one function that knows where payload-contract's shipped data lives — the committed files in a checkout, `data/<kind>` inside the installed package, or `PAYLOAD_CONTRACT_DATA/<kind>` when set.

Part of [payload-contract](https://github.com/LudwigGerdes/payload-contract), which generates and runs contract tests from the payloads a workflow trigger can receive. n8n is the first supported platform. This is an internal workspace library: it is not published on its own, and is bundled into the one published package, `payload-contract`.

MIT licensed. Not affiliated with n8n GmbH.
