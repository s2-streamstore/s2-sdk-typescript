---
"@s2-dev/streamstore": patch
---

Fix duplicate appends when the per-attempt ack timeout fires while `S2SAppendSession.submit()` is parked on lazy HTTP/2 stream initialization. `sendBatch()` now refuses to write after `close()` has set `this.closed`, and `RetryAppendSession.recover()` starts closing the old session before the backoff sleep so the closed flag is set throughout the backoff window. Without both changes, an orphaned `submit()` continuation whose `initPromise` resolved during backoff would write a batch the retry layer had already decided to abandon, and the resubmit on a fresh session would append the same batch a second time (S2 has no dedup for non-idempotent appends).
