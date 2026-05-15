---
"@s2-dev/resumable-stream": major
---

Simplify the resumable-stream integration surface and add Anthropic replay support.

- Add `@s2-dev/resumable-stream/anthropic` and `@s2-dev/resumable-stream/anthropic/client` for persisting Anthropic Messages stream events and subscribing to replay SSE.
- Replace the TanStack client helper with `createConnection` from `@s2-dev/resumable-stream/tanstack-ai/client`; the previous `createS2Connection` helper and stop-oriented client options are removed.
- Share replay cursor handling and reconnect utilities across provider clients.
- Tighten session replay behavior around SSE `id:` cursors and active session claims.
