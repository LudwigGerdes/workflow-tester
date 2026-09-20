# Vendor catalogs

`<vendor>/<specVersion>/catalog.json` is what payload-contract knows about a vendor's
webhooks: the list of event names it publishes, and — for the curated events
in `../sources.yaml` — the dereferenced JSON Schema and example payloads.
Everything a run touches is here; nothing is fetched at run time.

**Regenerate** with `pnpm ingest` inside `packages/vendors`
(`scripts/ingest.ts`), or `payload-contract contracts update --fetch`. Both download
the upstream spec into `~/.payload-contract/vendor-specs/` and rewrite the catalog.
Adding a vendor or event means editing `../sources.yaml` first.

**Provenance and licences.** The catalogs are derived from MIT-licensed
sources; see `THIRD_PARTY_NOTICES.md` at the repo root for the copyright
lines.

| Catalog | Derived from |
|---|---|
| `github/1.1.4/` | [github/rest-api-description](https://github.com/github/rest-api-description) (schemas) and [octokit/webhooks](https://github.com/octokit/webhooks) (example payloads) |
| `stripe/2026-08-26.dahlia/` | [stripe/openapi](https://github.com/stripe/openapi) |

GitHub and Stripe are trademarks of their respective owners; the catalogs
describe their public webhook formats and imply no affiliation.
