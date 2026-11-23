---
"@s2-dev/streamstore": patch
---

Fix transient DNS retry classification on Bun and protobuf decode error wrapping on unary fetch calls:

- Classify `EAI_AGAIN` as a retryable, side-effect-free connection error so transient DNS resolver failures on Bun are retried instead of failing immediately with status 0.
- Wrap protobuf decoding errors on HTTP 200 unary `read()` and `append()` responses in a non-retryable `S2Error` (with code `INVALID_RESPONSE` and the decode error as `cause`) instead of throwing raw protobuf-ts exceptions.
