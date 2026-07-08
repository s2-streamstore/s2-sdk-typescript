# @s2-dev/streamstore-patterns

## 2.1.4

### Patch Changes

- f7408f2: `injectDedupeHeaders` now throws a clear `S2Error` when a record already carries a reserved `_dedupe_seq` or `_writer_id` header, instead of silently appending duplicates. Previously the stale pre-existing header shadowed the injected sequence on the read side (readers pick the first match), corrupting dedupe filtering or crashing `decodeU64` on a malformed value. Validation runs before any record is mutated.
- 3e857be: Reject empty serializations in `SerializingAppendSession` with a clear `S2Error` instead of crashing. Previously a serializer producing zero bytes (e.g. `JSON.stringify(undefined)`) made `submit()` throw an opaque `TypeError` while `write()` threw an `S2Error`; both paths now throw the same `S2Error` explaining that the serializer must produce at least one byte.

## 2.1.3

### Patch Changes

- 98fa90c: fix: cap declared frame size to prevent reader OOM from untrusted `_frame_bytes` (#230)

  `FrameAssembler` allocated its reassembly buffer directly from the attacker-controlled
  `_frame_bytes` header, so a tiny record declaring a huge frame could force a reader to
  eagerly allocate that much memory. Frames whose declared size is non-positive or exceeds
  `maxFrameBytes` (default 100 MiB) are now dropped before allocating. The limit is
  configurable via `FrameAssembler`'s constructor and `DeserializingReadSession`'s
  `maxFrameBytes` option.

## 2.1.2

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

## 2.1.1

### Patch Changes

- 0105c3a: Bugfixes

## 2.1.0

### Minor Changes

- Updated dependencies [0d76a27]
  - @s2-dev/streamstore@0.21.0

## 2.0.0

### Patch Changes

- Updated dependencies [49e851c]
  - @s2-dev/streamstore@0.20.0

## 1.0.0

### Patch Changes

- Updated dependencies [f79de6a]
  - @s2-dev/streamstore@0.19.0

## 0.3.0

### Minor Changes

- 0f7a372: Adds per-writer idempotency key (in combination with message index), to allow for record deduplication even if a writer crashes

## 0.2.0

### Minor Changes

- 9144ee3: Initial release of streamstore-patterns package.
