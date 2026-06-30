---
"@s2-dev/resumable-stream": patch
---

Fix client `cancel()` hanging when the persistence branch of the teed stream stops iterating early. `readableStreamToAsyncIterable` now fire-and-forget cancels its reader before releasing the lock, so the abandoned teed branch is released and the sibling branch's `cancel()` resolves.
