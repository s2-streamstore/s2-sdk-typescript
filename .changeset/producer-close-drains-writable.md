---
"@s2-dev/streamstore": patch
---

`Producer.close()` now appends records written to `producer.writable` before it was called, and waits for their acks, as it does for `submit()`. Previously, records still queued in the writable were dropped while `close()` resolved successfully, including when closing through `await using` or `readable.cancel()`, and their `write()` promises later rejected with an unrelated stream state error. Records written or submitted after `close()` is called now fail with an `S2Error` "Producer is closed".
