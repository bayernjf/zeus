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
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
