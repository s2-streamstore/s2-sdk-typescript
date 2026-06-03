---
"@s2-dev/resumable-stream": patch
---

fix: SSE subscriptions reconnect on mid-stream errors instead of crashing (#249)

`subscribeSse` only wrapped the `fetchOk` call in try/catch, not the `for await`
over `pipeSseFrames`. When the response body errored mid-iteration, the throw
escaped before the reconnection logic could run, so the subscription crashed with
no recovery. The loop is now wrapped: it reconnects from the last cursor when
`reconnectBackoffMs` is set and rethrows when reconnect is disabled, matching the
TanStack `subscribeChunks` path. This restores behavior dropped in #241.
