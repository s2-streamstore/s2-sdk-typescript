---
"@s2-dev/streamstore": patch
---

Fix mislabeled `origin` on fetch read-session server errors. Non-416 HTTP error
responses and SSE `event: error` frames surfaced by the fetch (HTTP/1.1 + SSE)
read transport now carry `origin: "server"` instead of defaulting to `"sdk"`,
matching the s2s transport and the shared `withS2Error`/`withS2Data`/`makeServerError`
helpers. Callers branching on `S2Error.origin` to distinguish server faults from
SDK bugs now get the correct value on the fetch read path.
