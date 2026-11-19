# @s2-dev/streamstore

## 0.32.2

### Patch Changes

- 6ead3ad: Expose `privateDnsName` on `AwsPrivateNet`: the hostname to use as the account endpoint so that account requests also go over PrivateLink.

## 0.32.1

### Patch Changes

- acf260b: Expose `privateNet` on `LocationInfo`: the account's private networking details in a location, such as the AWS PrivateLink endpoint service name. It is absent until the account has a basin in the location.

## 0.32.0

### Minor Changes

- 9be5680: Add network policies (`s2.networkPolicies`, and `networkPolicy` when issuing access tokens) and the `token-activity` account metric set, which returns the new `record` metrics.

## 0.31.0

### Minor Changes

- 45b3f9c: Append sessions honour their `signal` on both transports. An abort fails the session with code `ABORTED`, without retrying: `appendSession()` rejects if the signal has already aborted, and otherwise appends that may have reached the server do. Before, an s2s session reconnected and kept acking appends.

  A failed append session gives its error only to appends that may have reached the server. Appends it never sent, and later `submit()` calls, reject with code `SESSION_CLOSED`, as after `close()`. That error's `cause` is the session's error, and its `hasNoSideEffects()` is true. Before, a batch never sent could be reported as `AppendIndefiniteFailureError`.

  A `Producer` record's `ack()` now shows whether it may have been sent: such a record settles with its batch's outcome, and any other rejects with `SESSION_CLOSED`. `Producer.submit()`, `flush()` and `close()` on a failed `Producer` still throw the session's error.

  Retries treat a batch as possibly applied only once it may have reached the server, so `appendRetryPolicy: "noSideEffects"` can now retry on fetch where it gave up.

  **Breaking:** after an append session fails, appends it never sent, later `submit()` calls and unsent `Producer` records reject with code `SESSION_CLOSED`, not the session's error. Get that from the error's `cause` or `failureCause()`, then open a new session.

  **Note:** on fetch, an already-aborted signal used to fail the first append's `ack()`. Now `appendSession()` rejects, as `readSession()` does.

  **Note:** when a `Producer` fails for a reason other than its session, such as `writable.abort()`, records already sent settle with their batch's outcome rather than rejecting at once. A custom `AppendSession` used with a `Producer` must settle every ticket it returns.

- 9b50fe3: **Breaking:** Drop Deno support. Deno is no longer detected as a distinct runtime, and its `node:http2` and `Request` workarounds have been removed.
- 8830ba8: `S2Stream.close()` ends the sessions opened from the handle and then settles, the same way on both transports. Read sessions end with an `S2Error` with code `ABORTED`, as when their `signal` aborts, and append sessions close as `AppendSession.close()` does. Previously, with a session open, `close()` never settled on s2s when the handle was the endpoint's last user, and otherwise resolved at once while its sessions kept running.

  **Breaking:** sessions no longer outlive the handle they were opened from. Finish reading and appending before closing the handle.

### Patch Changes

- 45b3f9c: s2s append sessions write batches in the order they were submitted. With compression on, a batch large enough to compress could be written after a smaller one submitted after it, which reordered records on the stream and failed the session.

  Append sessions send a batch as soon as it is submitted, rather than holding it until earlier batches are acked, so s2s pipelines appends. Under `appendRetryPolicy: "noSideEffects"`, a session can therefore give up more often when appends without `matchSeqNum` are pipelined: once a later batch may have reached the server, a failed earlier one is not retried.

  When an s2s append timed out while its HTTP/2 stream was still opening, the abandoned attempt could still write it once the stream opened, so the retry appended it twice, even under `appendRetryPolicy: "noSideEffects"` (#364).

  An append session whose transport fails an append by throwing now fails with that error, rather than hanging with no error.

  Batches submitted while others wait for capacity keep their order. Before, a small batch could be enqueued ahead of a larger one submitted before it. A batch larger than `maxInflightBytes` is sent once the session is empty, and fails, rather than waiting forever.

  A batch submitted just as `close()` is called no longer leaves its `ack()` pending forever.

- 88b49d9: `Producer.close()` now appends records written to `producer.writable` before it was called, and waits for their acks, as it does for records from `submit()`. Previously, records still queued in the writable were dropped while `close()` resolved successfully, including when closing through `await using` or `readable.cancel()`. `Producer.flush()` likewise now covers records written to the writable before it was called; previously it resolved without waiting for writes still queued in the stream.

  Records submitted after `close()` is called, and records written to the writable after a direct `close()` call, now fail with an `S2Error` "Producer is closed", or with the Producer's earlier error if it had already failed. Once a direct `close()` completes, the writable errors with that same error, so a pipe into it ends instead of waiting for its next record, and a later `writer.close()` rejects.

- 90ba29e: When the fetch transport fails to load its protobuf codec (used for bytes records and `as: "bytes"` reads), it now fails at once with "Failed to load the protobuf codec: …" and the import error as `cause`. Before, an import error worded like a failed fetch, such as Safari's "Load failed", was retried as a `NETWORK_ERROR`.
- 8830ba8: Read sessions honour their `signal` the same way on both transports: once it aborts, before `readSession()`, during setup or while waiting at the tail, the session ends with an `S2Error` with code `ABORTED` (status 499) and is not retried. Previously an s2s read session missed an abort that came before its HTTP/2 stream was set up, so a session following the tail waited forever, and a later abort ended it quietly (`done: true`). One-shot requests whose `signal` aborts before the response arrives now fail with this same error too, whatever reason `abort()` was given and including `AbortSignal.timeout()`. Before, they carried no code, or had status 0 when aborted with a reason.

  **Note:** on s2s, the default transport on Node, a `for await` loop over a read session now throws this error when the session's signal aborts, instead of ending. Catch `ABORTED` where you abort. Leaving the loop with `break` or `return` right after calling `abort()` still ends it quietly.

- e34e4f7: `AppendInput.create` rejects a record whose `meteredBytes` is not a non-negative integer, or whose `timestamp` is not a valid `Date` or a non-negative number of milliseconds up to `Number.MAX_SAFE_INTEGER`. Before, a hand-built record with a missing or `NaN` `meteredBytes` let an append session send only one batch at a time from then on, and an invalid timestamp was dropped on the fetch transport and threw a non-`S2Error` on s2s. A `null` timestamp still means no timestamp, now on s2s as well as fetch.

  `Producer.submit` rejects such a record on its own, rather than letting it fail the batch it would join. `BatchTransform` rejects it when it is written, rather than when its batch flushes, and sizes records by their `meteredBytes` instead of measuring each one again. An append session rejects a hand-built `AppendInput` whose `meteredBytes` is not a non-negative integer.

  s2s sessions build request paths without a double slash when the endpoint ends with `/`, such as `https://host/v1/`.

  Errors a fetch read session gets from the server have `origin: "server"` instead of `"sdk"`. Basin and stream management calls that fail with a plain-text body use that text as the error message, as account calls and appends already did, instead of the HTTP status text.

  Disposing a read session (`await using`, or `[Symbol.asyncDispose]()`) while a reader holds it ends the session, failing that reader's pending read with `ABORTED`. Before, it threw "ReadableStream is locked" and left the session open.

  `EncryptionKey.from` rejects a string key that is not standard, padded base64 with an `EncryptionKeyFormatError`, whose message does not include the key.

## 0.30.0

### Minor Changes

- e206abf: `accessTokens.listAll()` no longer accepts `includeDeleted`. Access tokens are never pending deletion, so the option had no effect, and it was being forwarded to the API as an undocumented `include_deleted` query parameter.

  **Breaking:** Remove `includeDeleted` from `ListAllAccessTokensInput`. Drop the option from any `accessTokens.listAll()` calls.

### Patch Changes

- f046126: Bound append retries by `requestTimeoutMillis` when a request stalls. Previously, after an ack timeout, the retry layer waited for the stalled request to settle before reconnecting, so `ticket.ack()` and `close()` could hang for minutes (or indefinitely) on a black-holed connection. Transport append sessions now cancel in-flight requests on close instead of waiting for them.
- a1949f1: Append sessions now fail with `AppendIndefiniteFailureError` when retries run out on a server error like `rate_limited` after an earlier attempt may have taken effect, as documented. Previously the "Max attempts exhausted" error dropped the server origin, so it was never wrapped.
- a8391af: Detect dead HTTP/2 connections in the s2s transport. Pooled connections with open streams are now pinged every 20s and destroyed if a ping goes unanswered for 10s, so sessions on a black-holed connection fail and reconnect instead of stalling until TCP gives up, and the pool stops reusing the dead connection.
- 25b01cb: `S2Stream.close()` no longer rejects when called while session transport creation is in flight and that creation fails. The error is still surfaced by the `readSession()` or `appendSession()` call that started it.
- 5e0ee53: `AppendRecord` factories now reject `NaN`, infinite, negative, or invalid-`Date` timestamps with a clear `S2Error`, instead of failing later during s2s serialization. Fractional millisecond timestamps are floored on the s2s transport, as they already were over fetch.

## 0.29.0

### Minor Changes

- 57b6941: Support the `estimated-billable-usage` account metric set and the `usd` metric unit.

## 0.28.0

### Minor Changes

- 570302c: Expose `storageClasses` and `defaultStorageClass` on location responses.

  **Breaking:** Remove the `StorageClass` type export and use `string` for storage-class names. Replace imports of `StorageClass` with `string`, and discover available values with `s2.locations.list()`. Omission and null reset behavior are unchanged.

### Patch Changes

- 4661d78: Preserve uncertainty across append retries. If an earlier attempt may have taken effect and the final attempt fails with an error that would otherwise report `hasNoSideEffects() === true`, unary appends and append sessions now fail with `AppendIndefiniteFailureError`, which exposes the final attempt's error as `finalAttemptError` (and `cause`) while reporting `hasNoSideEffects() === false` for the whole append.

## 0.27.0

### Minor Changes

- c330568: Add `streamConfig` to `AppendInput`, `ReadInput`, and `AppendSessionOptions`. It is sent as the `s2-stream-config` header and applied, over the basin's default stream configuration, only when the append or read auto-creates the stream; it is ignored if the stream already exists. Sessions resend it on every connect.

### Patch Changes

- 5a05d56: Validate stream names (1-512 bytes) and access token IDs (1-96 bytes) client-side in `streams.create`, `streams.ensure`, `basin.stream()` and `accessTokens.issue`, rejecting NUL bytes with an `S2Error` before any request is sent. Documents that stream names, access token IDs, and the `prefix` / `startAfter` list filters must not contain NUL bytes.

## 0.26.1

### Patch Changes

- 1f40121: Act on s2s reconnect advice once per minute, keep terminal `server_draining` reconnects outside the ordinary retry budget, and drop draining connections from the pool. Read sessions now anchor a timestamp or tail-relative start to the tail of an empty batch, so a reconnect resumes from the caught-up position instead of re-evaluating the original start against a newer tail.
- c9d10b9: Forward `clamp` on s2s read sessions. The HTTP/2 transport built its read query by hand and dropped the flag, so `readSession({ start: { clamp: true } })` returned 416 for a start beyond the tail under s2s while clamping under fetch.

## 0.26.0

### Minor Changes

- 1e5a6f5: Add a durable, non-terminal `Producer.flush()` boundary.

### Patch Changes

- 76ecd32: Defer loading the protobuf codec until a binary stream operation uses it.

## 0.25.1

### Patch Changes

- 7f39883: Prevent S2S read cancellation from enqueuing into a closed stream controller when HTTP/2 closes with a partial frame.
- 62f8761: Retry appends on undici connect timeouts (`UND_ERR_CONNECT_TIMEOUT`) under the `noSideEffects` retry policy. A connect timeout occurs before the TCP handshake completes, so no request bytes are sent and no mutation can occur — it is now classified as having no side effects, matching `ECONNREFUSED`.

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
