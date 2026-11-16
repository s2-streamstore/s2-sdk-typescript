---
"@s2-dev/streamstore": patch
---

Append sessions honour their `signal` the same way on both transports: once it aborts, the session fails with an `S2Error` with code `ABORTED` (status 499) and is not retried. `appendSession()` rejects with it if the signal has already aborted, and otherwise inflight appends and later `submit()` calls do. Previously an s2s append session took an abort for a dropped connection and reconnected, so its appends went on being acked.

Appends that fail before they are sent now get the plain error that stopped the session, rather than `AppendIndefiniteFailureError` whenever an earlier batch may have taken effect. When the session was aborted, that error reports `hasNoSideEffects() === true`. This covers batches an append session never sent, and `Producer` records whose batch was never handed to the session.

**Note:** on fetch, an already-aborted signal used to fail the first append's `ack()`. Now `appendSession()` rejects instead, as `readSession()` does. Catch `ABORTED` where you call `appendSession()` with a signal that may have aborted.
