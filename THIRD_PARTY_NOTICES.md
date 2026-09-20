# Third-party notices

payload-contract is released under the MIT License (see `LICENSE`). The material below
is distributed with it under its own terms and is **not** covered by that
licence.

## n8n (Sustainable Use License)

- **`packages/engine/bundled/2.10.0/nodes.json`** — 42 node descriptions
  (`INodeTypeDescription` objects) extracted verbatim from the
  `n8n-nodes-base@2.10.0` npm package by `scripts/bundle-node-types.ts`.
  See `packages/engine/bundled/README.md`.
- **`n8n-workflow@2.38.1`** — a runtime dependency of `payload-contract-engine`,
  `payload-contract-contracts` and other workspace packages. It is loaded unmodified
  from `node_modules` and never copied into this repository; it provides the
  expression evaluator and data proxy the engine runs workflows through.

Both are the work of n8n GmbH, licensed under the
[n8n Sustainable Use License](https://github.com/n8n-io/n8n/blob/master/LICENSE.md)
(with `LICENSE_EE.md` for enterprise-edition files, none of which are used
here). Vendor names and logos referenced in the node descriptions are
trademarks of their respective owners. payload-contract is not affiliated with or
endorsed by n8n GmbH.

payload-contract runs without the bundled descriptions: when
`packages/engine/bundled/` is absent or empty the engine loads an empty
description set, prints a note, and skips the one check that depends on them
(required-parameter verification).

## Vendor webhook catalogs (MIT)

`packages/vendors/data/**/catalog.json` is derived by
`packages/vendors/scripts/ingest.ts` from these sources, each MIT-licensed
per the `LICENSE` file in its repository:

| Catalog | Source | Copyright |
|---|---|---|
| `github/1.1.4/` (schemas, event list) | [github/rest-api-description](https://github.com/github/rest-api-description) — `LICENSE.md` | MIT, Copyright (c) 2020 GitHub |
| `github/1.1.4/` (example payloads) | [octokit/webhooks](https://github.com/octokit/webhooks) — `LICENSE` | MIT, Copyright (c) 2018 Gregor Martynus |
| `stripe/2026-08-26.dahlia/` | [stripe/openapi](https://github.com/stripe/openapi) — `LICENSE` | MIT, Copyright (c) 2011- Stripe, Inc. |

See `packages/vendors/data/README.md`.

## Runtime dependencies

Direct dependencies other than `n8n-workflow` are MIT or ISC licensed
(`ajv`, `yaml`, and the development toolchain: TypeScript under Apache-2.0,
vitest and tsx under MIT). Run `pnpm licenses list` for the full transitive
set.
