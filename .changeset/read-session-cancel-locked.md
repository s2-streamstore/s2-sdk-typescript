---
"@s2-dev/streamstore": patch
---

Fix read-session cancellation being silently dropped: `RetryReadSession.cancel` called `cancel()` on the inner transport stream, which is always locked by the retry pump's reader, so it rejected with `ERR_INVALID_STATE` (swallowed) and the underlying HTTP/2 stream stayed open. A live tail kept receiving server heartbeats indefinitely, which made a subsequent `S2Stream.close()` hang forever in the graceful HTTP/2 session close. Cancellation now goes through the pump's reader, so the transport stream and its HTTP/2 stream are torn down and `close()` completes.
