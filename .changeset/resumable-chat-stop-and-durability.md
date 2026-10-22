---
"@s2-dev/resumable-stream": minor
---

Chat adapters: add `stop`, abortable sources, and request rejoin; fix generations that could hang or lose their tail.

- `chat.stop(streamName)` ends the active generation. Readers receive the adapter's stop chunk (`{ type: "abort" }` for the AI SDK, `message_stop` for Anthropic, `RUN_FINISHED` for TanStack AI) and finish. With `resume: true`, `useChat`'s `stop()` only disconnects, so call this from a stop route.
- `makeResumable` accepts a function source, called once the stream is claimed with an `AbortSignal` that fires when the generation is stopped or taken over, even while it is idle. Pass it to the model call (`streamText({ abortSignal })`).
- `requestId` option: a retried request with the same id rejoins the active generation instead of getting 409.
- `onPersistError` config option for persistence failures (default `console.error`).
- Chunks larger than S2's 1 MiB record limit (for example `file` parts with data URLs) are split across records and reassembled on read. Previously the response and every replay hung.
- When persisting fails, the error chunk and terminal fence are appended directly, so readers finish instead of waiting forever.
- `single-use` generations are no longer trimmed when they complete, and `shared` claims keep the previous generation. Both trims could delete records a lagging reader had not read yet, truncating its response.
- Replay and `stop` locate the active generation from the tail of the stream instead of scanning it from the start, so `session` logs no longer get slower as they grow.
- `replay` with a `fromSeqNum` past the end of the stream (a cursor from a stream that was deleted and recreated) replays from the start. Previously it failed mid-response, so `subscribe` clients reconnected forever or ended without the new records.
- **Breaking:** the promise passed to `waitUntil` no longer rejects when persistence fails; failures go to `onPersistError` instead.
- **Breaking:** requires `@s2-dev/streamstore` 0.24.3 or later.
