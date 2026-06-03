---
"@s2-dev/resumable-stream": patch
---

fix: SSE reconnect now fails fast on permanent HTTP errors instead of retrying forever (#232)

The auto-reconnect loop in `subscribeSse` retried on every fetch error, so a permanent
failure (401/403/404) was retried indefinitely. `fetchOk` now throws an `HttpError`
carrying the status, and the loop surfaces permanent errors (4xx other than 408/429)
to the caller instead of reconnecting. Transient errors (network failures, 408, 429, 5xx)
are still retried.
