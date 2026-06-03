---
"@s2-dev/streamstore": patch
---

fix: `S2Stream.read()` no longer ignores the `count`/`bytes` budget when filtering command records (#231)

When called with `ignoreCommandRecords: true`, the unary `read()` previously looped and
re-issued a full read request (with the original `count`/`bytes`) for every command-only
batch, amplifying a single `count: 1` request into many requests. It now performs exactly
one request and filters command records out of that single batch client-side, matching the
Rust, Go, and Python SDKs.

The returned batch may be empty when every record in it was a command record. Use
`readSession()` to transparently keep reading until data records are found — the streaming
session already tracks the remaining budget correctly across reconnects.
