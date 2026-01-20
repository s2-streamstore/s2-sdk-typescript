---
"@s2-dev/streamstore": patch
---
  - Promote connectionTimeoutMillis and requestTimeoutMillis to top-level client options
  - Deprecate timeout settings under retry config (backwards-compatible)
  - Reduce default connection timeout from 5s to 3s
  - Change basins.listAll() and streams.listAll() to accept includeDeleted in options object instead of as first positional argument
