---
"@s2-dev/streamstore": patch
---

Copy mutable inputs (`Uint8Array`/`Buffer` bodies and headers, `Date`s, arrays, configs/options, and queued `WritableStream` chunks) on acceptance so post-call mutations cannot affect in-flight requests, retries, or reconnects, and compute metered record sizes from actual record payloads rather than trusting caller-supplied `meteredBytes`.
