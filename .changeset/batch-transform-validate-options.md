---
"@s2-dev/streamstore": patch
---

`BatchTransform` now validates `fencingToken` (at most 36 bytes) and `matchSeqNum` (a non-negative safe integer) in its constructor, like its other options. Previously a bad value was only rejected when the first batch was flushed, which errored the stream after records had already been written to it.
