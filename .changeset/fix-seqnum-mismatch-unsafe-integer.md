---
"@s2-dev/streamstore": patch
---

fix: append precondition errors no longer return a corrupted expected sequence number (#233)

`makeAppendPreconditionError` converted `seq_num_mismatch` with `Number(...)` and no
validation, so a value beyond `Number.MAX_SAFE_INTEGER` produced a corrupted
`expectedSeqNum`. It now throws an `S2Error` with code `UNSAFE_INTEGER` in that case,
matching the success-path guard (`bigintToSafeNumber`).
