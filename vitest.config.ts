import { defineConfig } from 'vitest/config';

/**
 * Vault bundle sealing (scrypt + AES-GCM), full-bundle restore, RSK keygen and
 * the spawned-subprocess acceptance checks are CPU-bound, so a loaded parallel
 * runner pushes them past the 5s default and the failures move between files.
 * The floor is raised once here instead of per suite.
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
