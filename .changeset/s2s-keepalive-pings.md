---
"@s2-dev/streamstore": patch
---

Detect dead HTTP/2 connections in the s2s transport. Pooled connections with open streams are now pinged every 20s and destroyed if a ping goes unanswered for 10s, so sessions on a black-holed connection fail and reconnect instead of stalling until TCP gives up, and the pool stops reusing the dead connection.
