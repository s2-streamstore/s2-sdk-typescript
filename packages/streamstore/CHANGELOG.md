# @s2-dev/streamstore

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
