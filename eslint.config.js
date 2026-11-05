// ESLint 9 flat config. Baseline policy (deferred #38): error-level rules only,
// so a clean run fails the CI gate without dragging every historical style
// wart in as a warning. Rules that TypeScript already owns via tsconfig
// (strict / noUnusedLocals / noUnusedParameters / exactOptionalPropertyTypes)
// are turned off here: duplicate enforcement adds noise, not signal.
//
// no-explicit-any is off in the baseline: the 24 remaining sites are protocol
// payloads without a static schema (JSON-RPC envelopes, foreign peer cards),
// where `any` is the documented honest annotation (deferred #37 closed on the
// same policy). Re-enable it as its own migration when those shapes get types.
//
// P3-4 (review 2026-11-05) — stage 1 is now enabled: `no-floating-promises` and
// `no-misused-promises` run on `src/**` and `tests/**` through the project service (tsconfig.json
// covers both). The remaining type-checked families still stay off: the original trial reported
// 2,534 findings (2,518 in TS files; the other 16 are `.mjs`/config files the project service does
// not cover) and unsafe-* / require-await are far above the 50-finding budget for a clean gate.
// Staged plan: (2) adopt `recommendedTypeChecked` per directory (core/ first) so each step is
// reviewable; (3) only after the unsafe-* families are typed down to zero does the whole config
// switch. Until then tsc strict remains the type-level gate.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'packages/zeus-client/dist/', 'node_modules/'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
);
