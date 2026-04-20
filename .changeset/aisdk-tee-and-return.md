---
"@s2-dev/resumable-stream": minor
---

- `makeResumable` now returns the `UIMessageChunk` stream as SSE directly in the response body (previously returned JSON `{ stream, fromSeqNum }`). The source is teed: one branch streams to the client, the other persists to S2.
- `replay` no longer accepts a `fromSeqNum` argument.
- `createS2Transport` and `S2TransportConfig` are removed. Use `new DefaultChatTransport({ api })` from `ai`; the default reconnect URL (`${api}/${chatId}/stream`) matches `chat.replay(...)`. Customize via `prepareReconnectToStreamRequest` if needed.
- Error chunks now include the upstream error message instead of a hardcoded string.
- Shared-mode streams now use a sliding liveness lease: if an active generation hasn't written any record (fence, data, or trim) for `leaseDurationMs` (default 1 minute), a new claim takes it over. Long-running generations that keep streaming are unaffected. The lease slides forward with every record, so `leaseDurationMs` is the maximum tolerated *pause within* a generation, not total generation duration. Previously, an abandoned non-terminal fence locked the stream forever.
- The generic `S2_LINGER_DURATION` default (`createResumableStreamContext`) dropped from 5000ms to 500ms. The AI SDK path already defaults to 50ms.
- Single-use streams now write a trim after the terminal fence at end-of-generation, so completed streams self-GC via s2's `delete-on-empty` rather than piling up under the retention policy.
- Single-use opening fences are appended with `matchSeqNum: 0`, so a re-claim of the same stream name rejects with `409` even after the trim has propagated. The stream's tail seqnum stays above 0 until s2 GCs the stream entirely, which blocks accidental re-use of the same name.

Migration:

```ts
// before
const transport = createS2Transport({ api: "/api/chat", reconnectApi: "/api/chat/stream" });

// after
import { DefaultChatTransport } from "ai";
const transport = new DefaultChatTransport({ api: "/api/chat" });
```

The server-side `chat.makeResumable(...)` and `chat.replay(...)` call sites are unchanged (both still return a `Response`), but the GET reconnect route should be moved to `/api/chat/[id]/stream` to match `DefaultChatTransport`'s default shape.
