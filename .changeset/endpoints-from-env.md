---
"@s2-dev/streamstore": minor
---

`new S2(...)` now reads `S2_ACCOUNT_ENDPOINT` / `S2_BASIN_ENDPOINT` when `endpoints` is not passed, so pointing at s2-lite or another environment no longer requires `S2Environment.parse()`.
