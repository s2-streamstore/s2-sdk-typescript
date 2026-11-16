---
"@s2-dev/streamstore": patch
---

`Producer.close()` now appends records written to `producer.writable` before it was called, and waits for their acks, as it does for records from `submit()`. Previously, records still queued in the writable were dropped while `close()` resolved successfully, including when closing through `await using` or `readable.cancel()`, and their `write()` promises later rejected with an unrelated stream state error. `Producer.flush()` likewise now covers records written to the writable before it was called; previously it resolved without waiting for writes still queued in the stream.

Records submitted after `close()` is called, and records written to the writable after a direct `close()` call, now fail with an `S2Error` "Producer is closed", or with the Producer's earlier error if it had already failed. Once a direct `close()` completes, the writable errors with that same error, so a pipe into it ends instead of waiting for its next record, and a later `writer.close()` rejects.
