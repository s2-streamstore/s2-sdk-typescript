---
"@s2-dev/streamstore": patch
---

Pool HTTP/2 connections in the s2s transport: all streams targeting the same endpoint now share one connection, dialed lazily on the first request, instead of dialing one connection per `S2Stream` handle. Each connection carries up to 100 concurrent requests; beyond that, load spills over to additional connections. Connections are closed when the last stream handle using the endpoint is closed.
