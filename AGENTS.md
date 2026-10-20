# Agent Instructions

- Package manager is `bun`. Don't add, remove, or upgrade dependencies, or edit `bun.lock`, unless asked.
- Before committing, run `bun run check` (biome + tsc for every package) and `bun run test`.
  `*.e2e.test.ts` files need `S2_ACCESS_TOKEN` and are skipped without it.
- Never edit `packages/streamstore/src/generated/` by hand; regenerate it from `s2-specs` with `bun run gen:openapi` / `bun run gen:proto`.
- Every user-facing change needs a changeset in `.changeset/` (`patch`, or `minor` for breaking changes while pre-1.0, with a **Breaking:** note).
- PR title + description become the squashed commit message; use conventional commit format.
- Keep tests few and load-bearing:
  - Test behavior that no single piece of code shows, such as invariants across components, concurrency, or I/O.
  - Don't test a lone guard, branch, ordering, or one-line rule; a comment explaining why guards it better.
  - A test must fail when what it guards breaks. Check by breaking the code or running against the base branch, and make it fail fast rather than hang.
  - Prefer one test that pins an invariant over several that restate its steps.
  - A bug that broke real behavior should get a regression test, written like any other test: in the file for that behavior, named for the behavior rather than the issue (mention the issue number in a comment). Don't add per-issue `issue-NNN.test.ts` files.
