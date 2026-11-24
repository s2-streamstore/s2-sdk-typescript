---
"@s2-dev/streamstore": minor
---

Harden endpoint, basin name, record size, and input handling:

- **Breaking:** `S2Endpoints` and `S2Environment.parse()` now require both `account` and `basin` endpoints when overriding defaults, reject paths, query strings, fragments, user info, port `0`, invalid hosts/IPs, and mixed schemes with an `S2Error`, and only send the `s2-basin` header when the basin endpoint does not contain a `{basin}.` placeholder.
- Validate basin names (`BasinNameStr`) consistently across `S2Basin`, `basins.create`, `basins.getConfig`, `basins.delete`, `basins.ensure`, `basins.reconfigure`, `metrics.basin`, and `metrics.stream` before making any request.
- Copy mutable `Uint8Array`/`Buffer` bodies and headers, `Date`s, arrays, and configs/options on acceptance so caller mutations after a call or `submit()` cannot affect in-flight requests, retries, or reconnects.
- Compute metered record sizes from actual record payloads rather than trusting caller-supplied `meteredBytes`.
