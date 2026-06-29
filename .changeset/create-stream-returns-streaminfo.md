---
"@s2-dev/streamstore": patch
---

Fix `streams.create()` to return `StreamInfo` (with `name`, `createdAt`, `deletedAt`) and normalize date fields to `Date` objects, matching `list()` and `ensure()`. It was previously typed as `{ config }` and left dates as raw strings.
