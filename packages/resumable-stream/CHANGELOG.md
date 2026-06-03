# @s2-dev/resumable-stream

## 3.0.1

### Patch Changes

- a478434: fix: `persistToS2` now actually invokes `onSeqNumMismatch` (#248)

  The per-record `instanceof SeqNumMismatchError` check was unreachable — `Producer.submit()`
  wraps a pump failure in a generic `S2Error`, so the callback never fired. The genuine
  `SeqNumMismatchError` surfaces from `producer.close()`, so the handling now runs after the
  producer is closed: when the persist failure is (or contains) a `SeqNumMismatchError` and an
  `onSeqNumMismatch` callback was provided, it's invoked and treated as an expected
  fenced/concurrent-writer condition instead of being thrown. Callers without the callback are
  unaffected (the failure still throws).

- 6019944: fix: SSE reconnect now fails fast on permanent HTTP errors instead of retrying forever (#232)

  The auto-reconnect loop in `subscribeSse` retried on every fetch error, so a permanent
  failure (401/403/404) was retried indefinitely. `fetchOk` now throws an `HttpError`
  carrying the status, and the loop surfaces permanent errors (4xx other than 408/429)
  to the caller instead of reconnecting. Transient errors (network failures, 408, 429, 5xx)
  are still retried.

- f3ec15a: fix: SSE subscriptions reconnect on mid-stream errors instead of crashing (#249)

  `subscribeSse` only wrapped the `fetchOk` call in try/catch, not the `for await`
  over `pipeSseFrames`. When the response body errored mid-iteration, the throw
  escaped before the reconnection logic could run, so the subscription crashed with
  no recovery. The loop is now wrapped: it reconnects from the last cursor when
  `reconnectBackoffMs` is set and rethrows when reconnect is disabled, matching the
  TanStack `subscribeChunks` path. This restores behavior dropped in #241.

- b4499c6: fix: TanStack AI chat no longer hangs when the replay endpoint returns HTTP 204 (#250)

  `subscribeChunks` returned an empty stream on a 204/no-body replay response, so
  TanStack's subscription loop ended without a terminal chunk and `streamResponse()`
  hung forever on `processingComplete`. It now yields a synthetic `RUN_FINISHED` so
  the subscription terminates cleanly. This restores the behavior dropped in #241.

## 3.0.0

### Major Changes

- 6c4686a: Simplify the resumable-stream integrations.

## 2.1.0

### Minor Changes

- 27806e1: Add TanStack AI helpers for S2-backed session replay:

  - `@s2-dev/resumable-stream/tanstack-ai` exposes `createResumableChat` for TanStack `StreamChunk` streams.
  - `@s2-dev/resumable-stream/tanstack-ai/client` exposes `createConnection` for TanStack `useChat`.
  - Session mode stores TanStack stream chunks in S2, claims new turns from the stream tail, and supports replay cursor resume.

## 2.0.1

### Patch Changes

- 62698b8: Update readme

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
