---
"@s2-dev/streamstore": patch
---

Forward `clamp` on s2s read sessions. The HTTP/2 transport built its read query by hand and dropped the flag, so `readSession({ start: { clamp: true } })` returned 416 for a start beyond the tail under s2s while clamping under fetch.
