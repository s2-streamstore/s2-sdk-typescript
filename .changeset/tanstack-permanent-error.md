---
"@s2-dev/resumable-stream": patch
---

TanStack AI `subscribe()` now fails fast on permanent HTTP errors (4xx other than 408/429) when `reconnectBackoffMs` is configured, matching `subscribeSse`. Previously it retried forever on 401/403/404, busy-looping until the caller aborted instead of surfacing the error.
