---
"@s2-dev/streamstore": patch
---

Validate stream names (1-512 bytes) and access token IDs (1-96 bytes) client-side in `streams.create`, `streams.ensure`, `basin.stream()` and `accessTokens.issue`, rejecting NUL bytes with an `S2Error` before any request is sent. Documents that stream names, access token IDs, and the `prefix` / `startAfter` list filters must not contain NUL bytes.
