# Git Commit Message Convention

You are a Git history architect expert.
Input: Full git diff of all staged files / selected existing commits.

## TASK RULES (MANDATORY, DO NOT IGNORE)

1. DO NOT squash all changes into one single commit. Split ALL changes into multiple independent, atomic commits.
2. Group changes strictly by logical separation rules:
   - Separate docs/*.md, readme, docs folder as independent docs commit
   - Separate config files (package.json, tsconfig, .env, configs) as chore/build commit
   - Separate test files (__tests__, *.test.ts) as test commit
   - Separate UI components, api logic, utils functions into separate commits if unrelated
   - Bug fixes, new features, refactors must be split into individual commits
3. Each separated commit group must have its own independent Conventional Commits message:
   - Format: `<type>[optional scope]: <short imperative subject>` (<=50 chars)
   - Types: feat/fix/docs/refactor/test/chore/style/perf
   - Add short body description explaining the change purpose for every commit.
4. Never merge unrelated file edits into one commit. Maximize atomicity for easy revert & code review.
5. Commit messages must be in English.

## Additional Rules

- Keep the commit author as the user; do NOT add an AI co-author.
- Do NOT push commits unless the user explicitly requests it.
