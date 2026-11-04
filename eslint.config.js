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
// P3-4 (review 2026-11-02) — type-checked rules stay off for now. A trial run
// with `recommendedTypeChecked` (projectService) reported 2,534 findings
// (2,518 in TS files; the other 16 are `.mjs`/config files the project service
// does not cover): no-unsafe-member-access 1,054, require-await 405,
// no-unsafe-assignment 375, no-unnecessary-type-assertion 246, unsafe-call 153,
// no-base-to-string 99, unsafe-argument 80, unsafe-return 56, and the one that
// matters most, no-floating-promises 22. Far above the 50-finding budget for a
// clean gate, so this batch does not flip it. Staged plan: (1) enable only
// `no-floating-promises` + `no-misused-promises` and clear the 22 sites;
// (2) then adopt `recommendedTypeChecked` per directory (core/ first) so each
// step is reviewable; (3) only after the unsafe-* families are typed down to
// zero does the whole config switch. Until then tsc strict remains the
// type-level gate.
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
);
