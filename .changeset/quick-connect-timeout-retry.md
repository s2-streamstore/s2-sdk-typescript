---
"@s2-dev/streamstore": patch
---

Retry appends on undici connect timeouts (`UND_ERR_CONNECT_TIMEOUT`) under the `noSideEffects` retry policy. A connect timeout occurs before the TCP handshake completes, so no request bytes are sent and no mutation can occur — it is now classified as having no side effects, matching `ECONNREFUSED`.
