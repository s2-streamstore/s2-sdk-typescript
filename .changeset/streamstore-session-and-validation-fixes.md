---
"@s2-dev/streamstore": patch
---

Fix session recovery, read delivery, and hand-built append input validation bugs:

- Reset abandoned s2s HTTP/2 append streams during retry recovery so a stalled server on a failed attempt cannot hold a connection pool slot open and hang `S2Stream.close()`.
- Validate hand-built `AppendInput` batches (batch size/count limits, record `timestamp` and `meteredBytes`, `fencingToken`, and `matchSeqNum`) in `S2Stream.append()` and `AppendSession.submit()` before queueing or encoding, rejecting invalid inputs with `S2Error` while leaving open sessions usable.
- Drain already-buffered records in `ReadSession` before surfacing a terminal transport error (while still dropping buffered records immediately on abort), so reconnecting from `nextReadPosition()` after a failed read session does not skip records that were already fetched.
- Reset the `ReadSession` retry budget on empty heartbeat batches so long-lived tail-following reads on quiet streams survive non-consecutive transient errors.
