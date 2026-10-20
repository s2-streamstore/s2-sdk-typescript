---
"@s2-dev/streamstore": patch
---

`S2Stream.close()` no longer rejects when called while session transport creation is in flight and that creation fails. The error is still surfaced by the `readSession()` or `appendSession()` call that started it.
