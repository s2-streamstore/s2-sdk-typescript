---
"@s2-dev/resumable-stream": minor
---

Chat adapters: stop, abortable sources, request rejoin, and durability fixes.

- `chat.stop(streamName)` ends the active generation; readers get the adapter's stop chunk.
- `makeResumable` accepts `(signal) => source`, called after the claim; `signal` aborts on stop or takeover.
- `requestId`: a retry rejoins the active generation instead of getting 409.
- `onPersistError` receives persistence failures (default `console.error`).
- `session` mode honors `leaseDurationMs`, so a crashed writer no longer locks the stream.
- Fix: chunks over 1 MiB hung the response and replays.
- Fix: readers hung when persistence failed.
- Fix: trims could truncate a lagging reader.
- Fix: replay of long `session` streams slowed down as they grew.
- Fix: a `fromSeqNum` past the tail failed instead of replaying from the start.
- **Breaking:** the `waitUntil` promise no longer rejects; use `onPersistError`.
- **Breaking:** requires `@s2-dev/streamstore` >= 0.24.3.
