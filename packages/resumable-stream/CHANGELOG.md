# @s2-dev/resumable-stream

## 2.0.0

### Major Changes

- 7ea2cea: - `makeResumable` now returns the `UIMessageChunk` stream as SSE directly in the response body (previously returned JSON `{ stream, fromSeqNum }`). The source is teed: one branch streams to the client, the other persists to S2.

  - `replay` no longer accepts a `fromSeqNum` argument.
  - `createS2Transport` and `S2TransportConfig` are removed. Use `new DefaultChatTransport({ api })` from `ai`; the default reconnect URL (`${api}/${chatId}/stream`) matches `chat.replay(...)`. Customize via `prepareReconnectToStreamRequest` if needed.
  - Error chunks no longer forward upstream error messages by default (previously leaked `err.message` directly). A new `ResumableChatConfig.onError?: (error: unknown) => string` lets callers opt into sanitized forwarding. Default emits the generic `"An error occurred."`.
  - Shared-mode streams now use a sliding liveness lease: if an active generation hasn't written any record (fence, data, or trim) for `leaseDurationMs` (default 5 seconds), a new claim takes it over. Long-running generations that keep streaming are unaffected. The lease slides forward with every record, so `leaseDurationMs` is the maximum tolerated _pause within_ a generation, not total generation duration. Previously, an abandoned non-terminal fence locked the stream forever.
  - Environment variable `S2_LINGER_DURATION` renamed to `S2_LINGER_DURATION_MS`. Default dropped from 5000ms to 500ms on the generic `createResumableStreamContext` path. The AI SDK path already defaults to 50ms.
  - Single-use streams now write a trim after the terminal fence at end-of-generation. Combined with `delete-on-empty` on the basin/stream config, completed single-use streams self-GC rather than piling up under the retention policy. Without `delete-on-empty`, the stream is still emptied by the trim and will expire under the retention policy as before.
  - Single-use opening fences are appended with `matchSeqNum: 0`, so a re-claim of the same stream name rejects with `409` even after the trim has propagated. The stream's tail seqnum stays above 0 until s2 GCs the stream entirely, which blocks accidental re-use of the same name.
  - Peer range for `ai` raised from `>=4.0.0` to `>=5.0.0`.

  Migration:

  ```ts
  // before
  const transport = createS2Transport({
    api: "/api/chat",
    reconnectApi: "/api/chat/stream",
  });

  // after
  import { DefaultChatTransport } from "ai";
  const transport = new DefaultChatTransport({ api: "/api/chat" });
  ```

  The server-side `chat.makeResumable(...)` and `chat.replay(...)` call sites are unchanged (both still return a `Response`), but the GET reconnect route should be moved to `/api/chat/[id]/stream` to match `DefaultChatTransport`'s default shape.

## 1.10.3

### Patch Changes

- 2d9d79c: misc bugfixes:
  - Enforce 1 MiB minimum for maxInflightBytes (#129)
  - Allow canSetUserAgentHeader in non-browser runtimes (#131)
  - Respect backpressure in EventStream pull() (#161)
  - Stop retry sessions promptly on cancel and abort (#162)
  - Preserve non-plain objects in case conversion (#163)
  - Skip command-only batches when ignoreCommandRecords enabled (#164)
  - Propagate original Producer.close() errors instead of TypeError (#165)
  - Cancel fetch transport iterators on early termination (#166)
  - Reject endpoints with query strings or hash fragments (#167, #178)
  - Fail blocked submits fast when close() races backpressure (#177)
  - Wake idle RetryAppendSession pumps on abort() (#179)
  - Release reader locks and cancel upstream on deserialize errors (#180)
  - Validate S2S frame length to prevent parser desync (#182)
  - Normalize deleteOnEmpty.minAgeSecs during reconfigure (#183)
  - Allow iterator return()/throw() after stream exhaustion (#184)
  - Fall back to manual S2S iterator when native async iteration throws (#184)
  - Drop oversized framed records without crashing FrameAssembler (#192)
  - Reject NaN and non-finite batch configuration values (#193)
  - resumeStream returns null on session creation failure (#194)
  - Validate fencing token length in AppendRecord.fence() (#195)
  - Exclude path params from reconfigure request body (#196)
  - Export BatchSubmitTicket as value, not type-only (#197)

## 1.10.2

### Patch Changes

- cb14923: feat: add AI SDK durability support

## 1.10.1

### Patch Changes

- 362c138: Migrate internals to streamstore v2 SDK APIs and add endpoint support for s2-lite.
