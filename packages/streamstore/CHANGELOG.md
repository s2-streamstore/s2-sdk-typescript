# @s2-dev/streamstore

## 0.25.0

### Minor Changes

- 5fb540d: Add `isCaughtUp()` and `caughtUp()` on read sessions to signal when reads reach the tail.

### Patch Changes

- 5fb540d: Extract caught-up tracking into a reusable transport-neutral component.
- ef1f949: - Test suite: allow correctness test reads to outlive prolonged append outages and cleanly cancelling concurrent work on failure
  - Normalize undici network failures so interrupted requests and response streams participate in SDK retry handling
- 5fb540d: Update s2-specs and regenerate the generated types.

## 0.24.3

### Patch Changes

- 46abdc9: Re-enable the HTTP/2 (s2s) transport on Bun >= 1.3.11, where Bun's `node:http2` connection-level flow control is fixed (oven-sh/bun#26917). Older Bun versions keep the fetch transport fallback.
- 5cba2c2: Enable the HTTP/2 (s2s) transport on Deno >= 2.7.5. Buffers response body chunks until headers arrive, working around Deno's `node:http2` emitting `data` before `response`; older Deno versions keep the fetch transport fallback.
- 51e38a7: Pool HTTP/2 connections in the s2s transport: all streams targeting the same endpoint now share one connection, opened lazily on the first request, instead of one connection per `S2Stream` handle. Each connection carries up to 100 concurrent requests; beyond that, additional connections are opened. Connections are closed when the last stream handle using the endpoint is closed.

## 0.24.2

### Patch Changes

- 2149094: Change the default account endpoint from `aws.s2.dev` to `a.s2.dev`. The previous endpoint continues to work, so existing configurations are unaffected.
- 825cb7d: Fix `streams.create()` to return `StreamInfo` (with `name`, `createdAt`, `deletedAt`) and normalize date fields to `Date` objects, matching `list()` and `ensure()`. It was previously typed as `{ config }` and left dates as raw strings.
- 7cf9eb0: Make append-session bookkeeping O(1) per ack instead of O(queue depth): replace array `shift()` with an amortized O(1) FIFO queue (inflight batches, capacity waiters, pending acks), and drain new submissions from a dedicated queue instead of rescanning the full inflight queue every pump cycle.
- 19a3e23: Fix read-session cancellation being silently dropped: `RetryReadSession.cancel` called `cancel()` on the inner transport stream, which is always locked by the retry pump's reader, so it rejected with `ERR_INVALID_STATE` (swallowed) and the underlying HTTP/2 stream stayed open. A live tail kept receiving server heartbeats indefinitely, which made a subsequent `S2Stream.close()` hang forever in the graceful HTTP/2 session close. Cancellation now goes through the pump's reader, so the transport stream and its HTTP/2 stream are torn down and `close()` completes.
- 8287128: Report a clear protocol error when the S2S transport receives a compressed frame for an algorithm that was never negotiated, instead of the misleading "zlib module has not been loaded".

## 0.24.1

### Patch Changes

- c543af5: fix: abort during an in-flight append no longer corrupts capacity accounting (#203)
- df2daab: - Treat browser TypeError("network error") as retryable SDK network error.
  - Make fetch read-session cleanup tolerate reader.cancel() failures instead of leaking raw errors.
  - Defensively retry if a transport read stream throws directly.
  - Increase fetch SSE inactivity watchdog from 20s to 25s.
  - Remove misleading stale-timeout debug log & add some additional context to other logs
  - Add regression tests and patch changeset.
- 1adac12: fix: metrics `basin()`/`stream()` no longer send path params in the query string (#235)

  Both methods spread `...args` into the request `query`, so `basin` (and `stream`) were
  serialized into the URL query string in addition to the path. They now pass `path` and
  `query` explicitly — only `{ basin }` / `{ basin, stream }` in the path and only
  `set/start/end/interval` in the query — matching the OpenAPI spec and the Go and Python SDKs.

- 0acd383: fix: `S2Stream.read()` no longer ignores the `count`/`bytes` budget when filtering command records (#231)

  When called with `ignoreCommandRecords: true`, the unary `read()` previously looped and
  re-issued a full read request (with the original `count`/`bytes`) for every command-only
  batch, amplifying a single `count: 1` request into many requests. It now performs exactly
  one request and filters command records out of that single batch client-side, matching the
  Rust, Go, and Python SDKs.

  The returned batch may be empty when every record in it was a command record. Use
  `readSession()` to transparently keep reading until data records are found — the streaming
  session already tracks the remaining budget correctly across reconnects.

## 0.24.0

### Minor Changes

- 5c0ed79: - refactor!: BasinScope now Location, and is free string instead of enum

  - feat: adds `location` related RPCs

  Breaking changes:

  - CreateBasinInput.scope replaced by location
  - EnsureBasinInput.scope replaced by location
  - BasinInfo.scope replaced by location
  - root export BasinScope removed and replaced by LocationName
  - generated API.BasinScope no longer exists because the spec no longer has it

## 0.23.0

### Minor Changes

- cdc822c: - Add stream encryption support to `@s2-dev/streamstore`, including
  `EncryptionKey`, `EncryptionAlgorithm`, and `EncryptionKeyInput`,
  per-stream encryption keys via `basin.stream({ encryptionKey })` and
  - `stream.withEncryptionKey()`, and basin-level `streamCipher`
    configuration.

### Patch Changes

- e17c444: Treat truncated fetch SSE reads as retryable errors instead of silently ending the read session.

## 0.22.10

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

## 0.22.9

### Patch Changes

- af0ea65: bugfix: BatchTransform.flush() error propagation

## 0.22.8

### Patch Changes

- bd3390f: Add Deno support (for fetch transports)

## 0.22.7

### Patch Changes

- 843b6e4: Changes error message for 416 (#158)

## 0.22.6

### Patch Changes

- 9f28893: - Improves decision tree for when to retry failed appends under `noSideEffects` policy
  - Fixes a bug regarding duplicated acks after append session recovery
- 12f0903: Bug fixes:

  - Fix `Producer.close()` to be idempotent, preventing TypeError on concurrent calls (#90)
  - Freeze and unexport `Redacted` prototype to prevent secret leakage (#91)
  - Re-check closed state after async transport creation in `readSession`/`appendSession` (#96)
  - Check all pipelined entries for idempotency under `noSideEffects` retry policy (#135)
  - Fix `BatchTransform` cancel hook, 0ms linger, controller init, and safe async flush (#136)
  - Use `AppendInput.create` in `SerializingAppendSession.write` for correct `meteredBytes` (#137)
  - Await pending ack handlers before exiting `Producer.runPump` (#138)
  - Prevent transport leak by caching creation promise in `S2Stream.getTransport` (#140)
  - Use exact matching in `isConnectionError` to prevent false positives (#141)
  - Clean up goaway and abort listeners in `S2SReadSession` to prevent memory leaks (#142)
  - Validate numeric inputs in `AppendRecord.trim` and `AppendInput.create` (#143)
  - Fix `EventStream` falsy value drops, missing return after done, and no-colon SSE parsing (#144)
  - Count connection failures toward `maxAttempts` in `RetryAppendSession` (#150)
  - Recompute `meteredBytes` after injecting dedupe headers (#151)
  - Add type guard before `in` operator to handle non-object error responses (#154)

## 0.22.5

### Patch Changes

- d9a5707: bug fixes for #115, #114, #117, #116, #119, #118, #120

## 0.22.4

### Patch Changes

- 013dd0a: fix: exclude bun from http2 autodetection

## 0.22.3

### Patch Changes

- fd5d960: fix: ignore command records

## 0.22.2

### Patch Changes

- 792b99a: - Promote connectionTimeoutMillis and requestTimeoutMillis to top-level client options
  - Deprecate timeout settings under retry config (backwards-compatible)
  - Reduce default connection timeout from 5s to 3s
  - Change basins.listAll() and streams.listAll() to accept includeDeleted in options object instead of as first positional argument
  - Rename delay config options to clarify they apply to base delay

## 0.22.1

### Patch Changes

- 0105c3a: Bugfixes

## 0.22.0

### Minor Changes

- 1c13db6: Minor fix to handle 416 explicitly in s2s read session

## 0.21.0

### Minor Changes

- 0d76a27: Adds a higher level Producer API which provides a per-record submit and ack interface (while using a configurable batcher over an append session)
  - API standardization around append session, in particular by introducing a BatchSubmitTicket type
    - `submit(batch)` returns `Promise<BatchSubmitTicket>`
      - this promise resolves only once a batch has been enqueued for submission in the session, and thus has received a deterministic ordering
      - users can separately await the Promise<AppendAck> returned by `BatchSubmitTicket.ack()` to block on durability
  - Switches to use of protobuf content-type for unary data plane requests when appending or reading binary records
    - base64 is still used for SSE read sessions
  - Allows explicit closing of an S2Stream, triggering cleanup of shared transport
  - Introduces a consolidated, documented SDK type layer including `AppendRecord` factories and `AppendInput.create(...)` validation
  - Improves transport/mapping internals: dedicated case-conversion utilities, centralized mappers, and protobuf support for bytes paths
  - Expanded docs/examples and test coverage (including retry/session and correctness-focused tests)

### Upgrade Notes

- Public types are now SDK-native (camelCase + Date): many previously re-exported generated (wire) types are replaced by new SDK types in `packages/streamstore/src/types.ts`
- Wire-format types moved behind API: instead of importing lots of snake_case types directly, use `import type { API } from "@s2-dev/streamstore"`
- Client endpoint config changed: use `S2ClientOptions.endpoints` / `S2Endpoints` (and `S2Environment.parse()` was added for env var config)
- Retry config renamed/changed: `retryBackoffDurationMillis` is removed; replaced with `minDelayMillis`/`maxDelayMillis` (exponential backoff) and new `connectionTimeoutMillis` (S2S transport only)
- Stream append API changed:
  - `S2Stream.append(records, { match_seq_num, fencing_token })` → `S2Stream.append(input: AppendInput)` with camelCase fields
  - New validation helpers/constants: `AppendRecord.string/bytes(...)`, `AppendInput.create(...)`
  - String headers are no longer `Record<string,string>`; use tuple arrays (`ReadonlyArray<[string,string]>`)
- Append session API changed:
  - `AppendSession.submit(...)` no longer returns `AppendAck` directly; it returns a `BatchSubmitTicket` and you await `ticket.ack()` to get the durable `AppendAck`
  - `AppendSession.writable` now accepts `AppendInput` (not `AppendArgs`)
- Metrics API timestamps changed: start/end inputs accept Date or milliseconds; timeseries points in responses are now `[Date, number]` (not epoch seconds)
- BatchTransform renamed/reshaped: `BatchTransformArgs` → `BatchTransformOptions`, `fencing_token`/`match_seq_num` → camelCase, and the transform output is now an `AppendInput` (not `{ records, ... }`)

## 0.20.0

### Minor Changes

- 49e851c: Fix error messages to contain more info

## 0.19.5

### Patch Changes

- 40ec9ce: Fix liveness timer issue for fetch-transport read session

## 0.19.4

### Patch Changes

- 12aca9c: Revert fix for fetch read session timeouts

## 0.19.3

### Patch Changes

- 7ccd6ce: Fix timeout logic for resumable read sessions with fetch transport

## 0.19.2

### Patch Changes

- dc6919c: Fixes bug around base64 encoding of binary append records when batches include mixed string/byte records

## 0.19.1

### Patch Changes

- 9ea91b5: Use static node:http2 import, and ignore from bundlers

## 0.19.0

### Minor Changes

- f79de6a: Gate node http/2 package for web bundling
