---
"@s2-dev/streamstore": patch
---

Append sessions honour their `signal` the same way on both transports: once it aborts, the session fails with an `S2Error` with code `ABORTED` (status 499) and is not retried. `appendSession()` rejects with it if the signal has already aborted, and otherwise inflight appends and later `submit()` calls do. Previously an s2s append session took an abort for a dropped connection and reconnected, so its appends went on being acked.

A batch that never reached the server now fails with `hasNoSideEffects() === true`, whatever stopped the session. This holds for `AppendSession.submit()` and a batch's `ack()`, and for a `Producer` record's `ack()`. A batch the fetch transport held in its queue, sending one append at a time, counts as never sent. Before, these got the session's error as it was, including `AppendIndefiniteFailureError` whenever an earlier batch may have taken effect. They now get a copy of the underlying error, of the same class, so `instanceof` checks still match but `===` against the original does not. `Producer.submit()` on a failed `Producer` still throws the original error. Retries now count a batch as possibly applied only once it may have reached the server, so `appendRetryPolicy: "noSideEffects"` can retry on fetch where it used to give up.

A `Producer` record's ack now settles with its own batch's outcome. Before, the first failure rejected every pending record with the same error, so a record the session held back unsent could report that it may have taken effect.

**Note:** on fetch, an already-aborted signal used to fail the first append's `ack()`. Now `appendSession()` rejects instead, as `readSession()` does. Catch `ABORTED` where you call `appendSession()` with a signal that may have aborted.

**Note:** when a `Producer` fails for a reason other than its session, such as `writable.abort()`, records already sent to the session are no longer rejected at once with that reason. Their acks settle when the session acks or fails their batch, possibly successfully. A custom `AppendSession` given to a `Producer` must settle every ticket it returned, as the SDK's does.
