---
"@s2-dev/streamstore": patch
---

`S2Stream.close()` no longer rejects when transport creation fails during a concurrent `close()`. A rejected lazy transport-creation promise is now treated as "nothing to close", so `close()` (and `[Symbol.asyncDispose]`) completes cleanup silently; the original construction error is still surfaced by the `readSession()`/`appendSession()` call that initiated transport creation.
