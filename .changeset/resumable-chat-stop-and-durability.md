---
"@s2-dev/resumable-stream": minor
---

Chat adapters: add `stop`, and fix generations that could hang or lose their tail.

- `chat.stop(streamName)` ends the active generation. Readers receive the adapter's stop chunk (`{ type: "abort" }` for the AI SDK) and finish, and the writer stops at its next append. With `resume: true`, `useChat`'s `stop()` only disconnects, so call this from a stop route.
- Chunks larger than S2's 1 MiB record limit (for example `file` parts with data URLs) are split across records and reassembled on read. Previously the append failed and the response and every replay hung.
- When persisting fails, the error chunk and terminal fence are appended directly, so readers finish instead of waiting forever.
- `single-use` generations are no longer trimmed when they complete, and `shared` claims keep the previous generation. Both trims could delete records a lagging reader had not read yet, truncating its response.
- The AI SDK README now uses `mode: "shared"` (so a chat can reuse one stream across turns) and `UIMessage`, and shows the stop route.
