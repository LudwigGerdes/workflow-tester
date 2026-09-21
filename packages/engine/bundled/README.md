# Bundled node descriptions

`<version>/nodes.json` holds n8n node descriptions (`INodeTypeDescription`
objects, 42 of them for 2.10.0) extracted verbatim from the
`n8n-nodes-base@<version>` npm package; `<version>/meta.json` records the
package and extraction time. workflow-test reads them to know which node parameters
are required and when they apply.

**Regenerate** with `pnpm bundle:node-types` at the repo root
(`scripts/bundle-node-types.ts`), which downloads the package from the npm
registry and harvests the descriptions for the node types listed in
`packages/engine/src/node-types/harvest.ts`.

**Licence.** These files are the work of n8n GmbH and are distributed under
the [n8n Sustainable Use License](https://github.com/n8n-io/n8n/blob/master/LICENSE.md).
They are **not** covered by this repository's MIT licence. Vendor names in
the descriptions are trademarks of their respective owners. workflow-test is not
affiliated with n8n GmbH.

**The tool runs without this folder.** If it is absent or empty, `loadNodeTypes`
returns an empty description set with a note, pure nodes run on their
built-in semantics, non-pure nodes are still reported as boundaries, and only
the required-parameter check is skipped. `packages/engine/test/without-bundle.test.ts`
proves it. `workflow-test node-types --version <v>` extracts a full set into
`~/.workflow-test/node-types/` instead.
