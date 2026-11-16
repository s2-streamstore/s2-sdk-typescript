---
"@s2-dev/streamstore": patch
---

When the fetch transport fails to load its protobuf codec (used for bytes records and `as: "bytes"` reads), it now fails at once with "Failed to load the protobuf codec: …" and the import error as `cause`. Before, an import error worded like a failed fetch, such as Safari's "Load failed", was retried as a `NETWORK_ERROR`.
