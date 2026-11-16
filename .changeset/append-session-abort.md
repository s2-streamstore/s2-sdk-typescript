---
"@s2-dev/streamstore": minor
---

Append sessions honour their `signal` the same way on both transports: once it aborts, the session fails with an `S2Error` with code `ABORTED` (status 499) and is not retried. `appendSession()` rejects with it if the signal has already aborted, and otherwise inflight appends do. Previously an s2s append session took an abort for a dropped connection and reconnected, so its appends went on being acked.

Once an append session fails, for any reason, only the appends it held get its error. Later `submit()` calls, including any waiting for capacity, reject with an `S2Error` with code `SESSION_CLOSED`, as after `close()`. Before, they got the session's error, so a batch submitted after the failure could be reported as `AppendIndefiniteFailureError` though it was never sent. A `Producer` on a failed session fails with the session's error.

Retries now count a batch as possibly applied only once it may have reached the server, so `appendRetryPolicy: "noSideEffects"` can retry on fetch where it used to give up.

**Breaking:** after an append session fails, `submit()` rejects with code `SESSION_CLOSED`, not the error the session failed with. To see why it failed, use `failureCause()` or the failed append's `ack()`. Close the session, and any `Producer` on it, and open a new one.

**Note:** on fetch, an already-aborted signal used to fail the first append's `ack()`. Now `appendSession()` rejects instead, as `readSession()` does. Catch `ABORTED` where you call `appendSession()` with a signal that may have aborted.
