---
"@s2-dev/streamstore": patch
---

Append sessions honour their `signal` the same way on both transports: once it aborts, the session fails with an `S2Error` with code `ABORTED` (status 499) and is not retried. `appendSession()` rejects with it if the signal has already aborted, and otherwise inflight appends and later `submit()` calls do. Previously an s2s append session took an abort for a dropped connection and reconnected, so its appends went on being acked. On fetch, an already-aborted signal failed the first append instead of `appendSession()`.

A batch submitted after an append session failed is now rejected with the plain error that ended the session. Before, it got `AppendIndefiniteFailureError` whenever an earlier batch may have taken effect, though it was never sent.
