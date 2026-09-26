import { defineConfig } from 'vitest/config';

/**
 * Vault bundle sealing (scrypt + AES-GCM), full-bundle restore, RSK keygen and
 * the spawned-subprocess acceptance checks are CPU-bound, so a loaded parallel
 * runner pushes them past the 5s default and the failures move between files.
 * The floor is raised once here instead of per suite.
 *
 * Measured 2026-09-26, because one unexplained red had gone unattributed: running
 * two full suites concurrently on this machine produced 3 and 4 failures (same
 * suite solo and in 7 sequential runs: 0), all of them the same shape - a
 * `vault.test.ts` case that costs 2.5s alone was killed at 25.0s, and
 * `http-diary.test.ts` at 24.1s. So that class of red is this ceiling firing
 * under contention, not a logic defect. Vitest reports a timeout as
 * `STACK_TRACE_ERROR`, which is why it read as mysterious; check for a concurrent
 * runner (another session, `npm test` twice) before treating such a red as real.
 * The one case that legitimately needs more headroom - verify-roster's process
 * spawns - sets it in its own file rather than raising the global floor, so a
 * genuine hang still fails in 20s everywhere else.
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
