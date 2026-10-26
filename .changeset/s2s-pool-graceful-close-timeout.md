---
"@s2-dev/streamstore": patch
---

Bound the pooled HTTP/2 session graceful close by a deadline with a `session.destroy()` fallback. Previously, when the last user detached, `Http2ConnectionPool.detach()` awaited `session.close(cb)` with no timeout and no fallback; on Bun (>= 1.3.11) a session can wedge — `session.close()` never invokes its callback and never emits `'close'` — after a stream is RST'd via no-arg `stream.close()` in the same tick as `session.request()`, before any response byte is processed, with a response frame arriving afterwards. The wedged close held `S2Stream.close()` / `transport.close()` forever. The pool now falls back to `session.destroy()` after a few seconds (mirrored in `evict()`), so close always resolves; destroying an evicted session with no open streams is semantically equivalent to a graceful close, so in-flight work is unaffected.
