---
"@s2-dev/streamstore": patch
---

`AppendInput.create` now recomputes each record's metered size with the exported `meteredBytes()` util and rejects a non-finite total, instead of summing the records' declared `meteredBytes` fields. A record with a missing or `NaN` `meteredBytes` previously produced an `AppendInput` carrying `meteredBytes: NaN`, which permanently wedged `RetryAppendSession`'s byte-based capacity queue: the submitting caller's `submit()` hung forever and, as the FIFO head, starved every concurrent waiter behind it (and via the `Producer` API, the entire producer). The boundary now enforces the existing invariant that `meteredBytes` equals the recomputed value (already used by `packages/patterns`'s dedupe injection and `BatchTransform`).
