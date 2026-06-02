---
"@s2-dev/streamstore": patch
---

fix: abort during an in-flight append no longer corrupts capacity accounting (#203)

If `abort()` fired while the append-session pump was parked in `waitForHead()`, a
late success from the transport was processed after `abort()` had already reset
`queuedBytes` to 0, so `releaseCapacity()` drove `queuedBytes` negative and
permanently corrupted backpressure accounting. The pump now checks `pumpStopped`
immediately after `waitForHead()` returns — matching the guards that already follow
every other await point in the pump — and exits without touching capacity state.
