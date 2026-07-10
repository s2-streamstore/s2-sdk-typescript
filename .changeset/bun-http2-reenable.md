---
"@s2-dev/streamstore": patch
---

Re-enable the HTTP/2 (s2s) transport on Bun >= 1.3.11, where Bun's `node:http2` connection-level flow control is fixed (oven-sh/bun#26917). Older Bun versions keep the fetch transport fallback.
