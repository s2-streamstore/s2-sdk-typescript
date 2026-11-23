---
"@s2-dev/streamstore": patch
---

Aborting `Producer.writable` (directly or via a failed `pipeTo` source) now aborts the underlying `AppendSession` immediately, including while a write or batch submission is blocked on backpressure. Queued batches waiting for session capacity are rejected with `SESSION_CLOSED` instead of being appended once capacity frees up, in-flight retries are cancelled rather than stalling teardown, and `pipeTo` preserves the source error.

Non-abort `Producer` failures (such as a `BatchTransform` error during `flush()`) also close the underlying session right away so capacity-parked batches reject without appending while already-accepted batches still settle.

Aborting `AppendSession.writable` while a `write()` is blocked on capacity now aborts the session immediately instead of waiting for capacity to release.
