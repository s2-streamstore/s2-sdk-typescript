# Development

Internal notes for maintainers.

## Development setup

Install the pre-commit hook to automatically format staged files before each commit:

```sh
ln -sf "$(pwd)/scripts/pre-commit" .git/hooks/pre-commit
```

This runs `biome check --write` on staged files. If biome finds issues it cannot fix, the commit will be blocked.

## Maintaining documentation snippets

- Run `bun run snippets` whenever you touch `README.md` or the snippet source files under `examples/`.
- `bun run check:snippets` (also part of `bun run check`) type-checks every example so regressions are caught in CI.
- Snippet blocks in markdown are delimited by `<!-- snippet:start NAME -->` / `<!-- snippet:end NAME -->`; never edit the generated code directly – update the matching file in `examples/` instead.
- To keep snippets small, add region markers to example files: `snippet-region REGION start` / `snippet-region REGION end`.
