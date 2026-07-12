---
"@s2-dev/streamstore": patch
---

Pool HTTP/2 connections in the s2s transport: all streams targeting the same endpoint now share one connection, opened lazily on the first request, instead of one connection per `S2Stream` handle. Each connection carries up to 100 concurrent requests; beyond that, additional connections are opened. Connections are closed when the last stream handle using the endpoint is closed.
