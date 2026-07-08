---
"@s2-dev/resumable-stream": patch
---

Fix HTTP/2 connection leaks in the chat adapter: `makeResumable` and `replay` created `S2Stream` handles that were never closed, leaking one persistent HTTP/2 session per streaming request in Node. Handles are now closed when the SSE response body completes, errors, or is cancelled; on claim failure; and before the 202 replay-delivery response. The streaming path also reuses the claim handle instead of opening a second connection, and `replay`'s SSE wrapper now propagates early termination to the underlying reader so read sessions are disposed on client cancel.
