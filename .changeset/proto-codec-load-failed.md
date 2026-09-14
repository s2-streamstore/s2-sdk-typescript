---
"@s2-dev/streamstore": patch
---

Fix Safari bytes-mode appends and reads surfacing a misleading, retryable `NETWORK_ERROR` (502) when the lazy protobuf chunk fails to load. `loadProtoCodec` now emits a dedicated non-retryable `PROTO_CODEC_LOAD_FAILED` error (status 0) instead of routing the dynamic-`import()` failure through `s2Error`, which on Safari reuses `"Load failed"` for both `fetch()` and `import()` network failures. Module-load failures now fail immediately without burning retry attempts or backoff.
