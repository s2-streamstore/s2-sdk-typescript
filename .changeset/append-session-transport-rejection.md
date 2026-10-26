---
"@s2-dev/streamstore": patch
---

Convert transport `submit()` rejections into error results so `RetryAppendSession` aborts instead of hanging. Previously, if the s2s transport's `submit()` rejected (e.g. `frameMessage` throwing `Message too large` for an oversized frame), the rejection escaped the retry pump through `waitForHead` and was swallowed by a debug-only `.catch()`, leaving the pump dead: pending and future `ticket.ack()` promises never settled, capacity was never released so `waitForCapacity` blocked forever, `close()` could resolve as if everything flushed, and `failureCause()` stayed `undefined`. Pipelined entries behind the rejecting head also leaked an unhandled promise rejection. The pump now converts rejections to `err(s2Error(e))` at both submit sites (`runPump` and `recover()`) and treats any pump crash as fatal via `abort()`, so the failure flows through the existing retry/abort machinery.
