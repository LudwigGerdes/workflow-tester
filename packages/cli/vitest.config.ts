import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    // The e2e cases spawn the runner and its sandbox. Vitest's 5s default is
    // enough on a developer machine and not on a CI runner, where these timed
    // out at ~5006ms. `packages/runner` already allows 30s for the same reason.
    testTimeout: 30_000,
  },
});
