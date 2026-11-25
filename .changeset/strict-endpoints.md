---
"@s2-dev/streamstore": minor
---

**Breaking:** `S2Endpoints` and `S2Environment.parse()` now require both `account` and `basin` endpoints when overriding defaults, reject paths, query strings, fragments, user info, port `0`, invalid hosts/IPs, and mixed schemes with an `S2Error`, and only send the `s2-basin` header when the basin endpoint does not contain a `{basin}.` placeholder.
