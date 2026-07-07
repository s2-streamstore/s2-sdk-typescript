---
"@s2-dev/streamstore-patterns": patch
---

`injectDedupeHeaders` now throws a clear `S2Error` when a record already carries a reserved `_dedupe_seq` or `_writer_id` header, instead of silently appending duplicates. Previously the stale pre-existing header shadowed the injected sequence on the read side (readers pick the first match), corrupting dedupe filtering or crashing `decodeU64` on a malformed value. Validation runs before any record is mutated.
