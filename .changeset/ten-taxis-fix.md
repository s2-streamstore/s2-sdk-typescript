---
"@s2-dev/streamstore": minor
---

- Add stream encryption support to `@s2-dev/streamstore`, including
`EncryptionKey`, `EncryptionAlgorithm`, and `EncryptionKeyInput`,
per-stream encryption keys via `basin.stream({ encryptionKey })` and
- `stream.withEncryptionKey()`, and basin-level `streamCipher`
configuration.
