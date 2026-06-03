---
"@s2-dev/streamstore": patch
---

fix: metrics `basin()`/`stream()` no longer send path params in the query string (#235)

Both methods spread `...args` into the request `query`, so `basin` (and `stream`) were
serialized into the URL query string in addition to the path. They now pass `path` and
`query` explicitly — only `{ basin }` / `{ basin, stream }` in the path and only
`set/start/end/interval` in the query — matching the OpenAPI spec and the Go and Python SDKs.
