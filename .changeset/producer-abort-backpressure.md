---
"@s2-dev/streamstore": minor
---

Aborting `Producer.writable` now aborts the underlying `AppendSession` immediately, including while a write or batch submission is blocked on backpressure. Queued batches waiting for session capacity are rejected with `SESSION_CLOSED` instead of being appended once capacity frees up, and in-flight retries are cancelled rather than stalling teardown.

Non-abort `Producer` failures (such as a `BatchTransform` error during `flush()`) also close the underlying session right away so capacity-parked batches reject without appending while already-accepted batches still settle.

Aborting `AppendSession.writable` while a `write()` is blocked on capacity now aborts the session immediately instead of waiting for capacity to release.

**Breaking:** aborting `Producer.writable` now matches `AppendSession.writable.abort()`:

- In-flight batches already sent to the server are cancelled and their tickets reject with `ABORTED` (carrying the abort reason as `cause`) instead of draining to an ack.
- `writer.abort(reason)` resolves once teardown completes instead of rejecting, so `ReadableStream.pipeTo(producer.writable)` preserves the upstream source error (note: per the Streams standard, `pipeTo` waits for an already in-flight `write()` before calling `abort`; pass an `AbortSignal` to `stream.appendSession()` to cancel mid-write under sustained backpressure).
- `Producer.close()` after `writer.abort(reason)` rejects with an `S2Error` with code `ABORTED` (status 499, `cause: reason`) instead of rethrowing the raw reason or wrapping it as status 500.
