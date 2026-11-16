---
"@s2-dev/streamstore": minor
---

Append sessions honour their `signal` the same way on both transports: once it aborts, the session fails with an `S2Error` with code `ABORTED` (status 499) and is not retried. `appendSession()` rejects with it if the signal has already aborted, and otherwise inflight appends do. Previously an s2s append session took an abort for a dropped connection and reconnected, so its appends went on being acked.

Once an append session fails, for any reason, only the appends it held get its error. Later `submit()` calls, including any waiting for capacity, reject with an `S2Error` with code `SESSION_CLOSED`, as after `close()`. Before, they got the session's error, so a batch submitted after the failure could be reported as `AppendIndefiniteFailureError` though it was never sent.

A `Producer` record's `ack()` now says whether the record was sent. A record whose batch the session accepted settles with that batch's outcome. A record that never reached the session rejects with `SESSION_CLOSED`. Before, the first failure rejected every pending record with the same error. `Producer.submit()`, `flush()` and `close()` on a failed `Producer` still throw the session's error.

Retries now count a batch as possibly applied only once it may have reached the server, so `appendRetryPolicy: "noSideEffects"` can retry on fetch where it used to give up.

**Breaking:** after an append session fails, `submit()` rejects with code `SESSION_CLOSED`, not the error the session failed with, and so does the `ack()` of a `Producer` record that was never sent. To see why it failed, use `failureCause()` or the failed append's `ack()`. Close the session, and any `Producer` on it, and open a new one.

**Note:** on fetch, an already-aborted signal used to fail the first append's `ack()`. Now `appendSession()` rejects instead, as `readSession()` does. Catch `ABORTED` where you call `appendSession()` with a signal that may have aborted.

**Note:** when a `Producer` fails for a reason other than its session, such as `writable.abort()`, records already sent to the session are no longer rejected at once. Their acks settle when the session acks or fails their batch, possibly successfully. A custom `AppendSession` given to a `Producer` must settle every ticket it returned, as the SDK's does.
