---
"@s2-dev/resumable-stream": minor
---

Add TanStack AI helpers for S2-backed session replay:

- `@s2-dev/resumable-stream/tanstack-ai` exposes `createResumableChat` for TanStack `StreamChunk` streams.
- `@s2-dev/resumable-stream/tanstack-ai/client` exposes `createS2Connection` for `useChat`.
- Session mode stores TanStack stream chunks in S2, creates replay-only in-memory snapshots on first load, supports cursor resume, and provides explicit server-side stop via `stopSession` / `stopUrl`.
