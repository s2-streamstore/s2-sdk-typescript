---
"@s2-dev/streamstore": patch
---

The s2s read session now closes its underlying HTTP/2 stream when the 20-second tail-idle timer fires. Previously the stream was leaked when the server stopped sending frames, permanently consuming a connection-pool slot (the pool only reclaims slots on stream `'close'`) and causing `S2Stream.close()` to hang in the graceful session close that waits for in-flight streams.
