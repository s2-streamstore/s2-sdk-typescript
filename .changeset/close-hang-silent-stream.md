---
"@s2-dev/streamstore": patch
---

Fix `Producer.close()` (and append-session recovery) hanging indefinitely when an established S2S HTTP/2 append stream stays open but stops delivering acks. `S2SAppendSession.close()` now RSTs the HTTP/2 stream (`NGHTTP2_CANCEL`) before draining pending acks, so the stream's `"close"` event fires and the existing `safeError` path drains the queue in bounded time. Previously it half-closed via `end()` only after an unbounded busy-wait that never exited on a silent peer.
