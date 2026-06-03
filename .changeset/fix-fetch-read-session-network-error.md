---
"@s2-dev/streamstore": patch
---

- Treat browser TypeError("network error") as retryable SDK network error.
- Make fetch read-session cleanup tolerate reader.cancel() failures instead of leaking raw errors.
- Defensively retry if a transport read stream throws directly.
- Increase fetch SSE inactivity watchdog from 20s to 25s.
- Remove misleading stale-timeout debug log & add some additional context to other logs
- Add regression tests and patch changeset.
