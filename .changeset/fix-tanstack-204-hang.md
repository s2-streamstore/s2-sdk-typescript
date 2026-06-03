---
"@s2-dev/resumable-stream": patch
---

fix: TanStack AI chat no longer hangs when the replay endpoint returns HTTP 204 (#250)

`subscribeChunks` returned an empty stream on a 204/no-body replay response, so
TanStack's subscription loop ended without a terminal chunk and `streamResponse()`
hung forever on `processingComplete`. It now yields a synthetic `RUN_FINISHED` so
the subscription terminates cleanly. This restores the behavior dropped in #241.
