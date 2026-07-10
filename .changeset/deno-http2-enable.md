---
"@s2-dev/streamstore": patch
---

Enable the HTTP/2 (s2s) transport on Deno >= 2.7.5. Buffers response body chunks until headers arrive, working around Deno's `node:http2` emitting `data` before `response`; older Deno versions keep the fetch transport fallback.
