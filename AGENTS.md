# Agent Instructions

- Use `bun`. Don't change dependencies or `bun.lock` unless asked.
- Run `bun run check` and `bun run test` before committing. E2E tests (`*.e2e.test.ts`) need `S2_ACCESS_TOKEN`.
- Don't edit `packages/streamstore/src/generated/` by hand. Regenerate with `bun run gen:openapi` or `bun run gen:proto`.
- Add a changeset for user-facing changes: `patch`, or `minor` with a **Breaking:** note for breaking changes.
- Use conventional commit PR titles. The PR title and description become the squash commit.
- Keep tests few and load-bearing:
  - Test behavior no single piece of code shows: invariants across components, concurrency, I/O.
  - Don't test a lone guard, branch, or one-line rule. A comment explaining why is better.
  - A test must fail when what it guards breaks. Verify against the base branch, and fail fast instead of hanging.
  - Prefer one test of an invariant over several that restate its steps.
  - Real bugs get regression tests that reference the issue.
