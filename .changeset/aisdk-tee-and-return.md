---
"@s2-dev/resumable-stream": minor
---

- `makeResumable` now returns the `UIMessageChunk` stream as SSE directly in the response body (previously returned JSON `{ stream, fromSeqNum }`). The source is teed: one branch streams to the client, the other persists to S2.
- `replay` no longer accepts a `fromSeqNum` argument.
- `createS2Transport` and `S2TransportConfig` are removed. Use `new DefaultChatTransport({ api })` from `ai` — the default reconnect URL (`${api}/${chatId}/stream`) matches `chat.replay(...)`. Customize via `prepareReconnectToStreamRequest` if needed.
- Error chunks now include the upstream error message instead of a hardcoded string.
- Shared-mode streams now use a time-based lease: if a generation dies without writing a terminal fence, a new claim can take over after `leaseDurationMs` (defaults to 5 minutes). Previously, an abandoned non-terminal fence locked the stream forever. Lease comparisons use client-supplied timestamps on fence records to avoid clock skew.
- The generic `S2_LINGER_DURATION` default (`createResumableStreamContext`) dropped from 5000ms to 500ms. The AI SDK path already defaults to 50ms.

Migration:

```ts
// before
const transport = createS2Transport({ api: "/api/chat", reconnectApi: "/api/chat/stream" });

// after
import { DefaultChatTransport } from "ai";
const transport = new DefaultChatTransport({ api: "/api/chat" });
```

The server-side `chat.makeResumable(...)` and `chat.replay(...)` call sites are unchanged (both still return a `Response`), but the GET reconnect route should be moved to `/api/chat/[id]/stream` to match `DefaultChatTransport`'s default shape.
