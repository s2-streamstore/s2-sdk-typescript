---
"@s2-dev/streamstore": minor
---

Append sessions honour their `signal` on both transports. An abort fails the session with code `ABORTED`, without retrying: `appendSession()` rejects if the signal has already aborted, and otherwise inflight appends do. Before, an s2s session reconnected and kept acking appends.

A failed append session gives its error only to the appends it held. Later `submit()` calls reject with code `SESSION_CLOSED`, as after `close()`. Before, they got the session's error, so a batch never sent could be reported as `AppendIndefiniteFailureError`.

A `Producer` record's `ack()` now shows whether it was sent: a sent record settles with its batch's outcome, and an unsent one rejects with `SESSION_CLOSED`. `Producer.submit()`, `flush()` and `close()` on a failed `Producer` still throw the session's error.

Retries treat a batch as possibly applied only once it may have reached the server, so `appendRetryPolicy: "noSideEffects"` can now retry on fetch where it gave up.

**Breaking:** after an append session fails, `submit()` and the `ack()` of an unsent `Producer` record reject with code `SESSION_CLOSED`, not the session's error. Get that from `failureCause()`, then open a new session.

**Note:** on fetch, an already-aborted signal used to fail the first append's `ack()`. Now `appendSession()` rejects, as `readSession()` does.

**Note:** when a `Producer` fails for a reason other than its session, such as `writable.abort()`, records already sent settle with their batch's outcome rather than rejecting at once. A custom `AppendSession` used with a `Producer` must settle every ticket it returns.
