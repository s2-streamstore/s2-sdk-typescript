# @s2-dev/streamstore

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
