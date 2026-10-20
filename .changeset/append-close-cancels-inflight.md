---
"@s2-dev/streamstore": patch
---

Bound append retries by `requestTimeoutMillis` when a request stalls. Previously, after an ack timeout, the retry layer waited for the stalled request to settle before reconnecting, so `ticket.ack()` and `close()` could hang for minutes (or indefinitely) on a black-holed connection. Transport append sessions now cancel in-flight requests on close instead of waiting for them.
