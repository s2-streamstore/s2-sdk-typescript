# @s2-dev/streamstore-patterns

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
