import { defineConfig } from 'vitest/config';

// Mirror of vitest.config.ts plus the clock-skew setup file, used only by the
// `clock-skew` CI job (deferred #24). See scripts/clock-skew-setup.mjs.
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
    setupFiles: ['scripts/clock-skew-setup.mjs'],
  },
});
