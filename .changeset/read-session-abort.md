---
"@s2-dev/streamstore": patch
---

Read sessions honour their `signal` the same way on both transports: once it aborts, before `readSession()`, during setup or while waiting at the tail, the session ends with an `S2Error` with code `ABORTED` (status 499) and is not retried. Previously an s2s read session missed an abort that came before its HTTP/2 stream was set up, so a session following the tail waited forever, and a later abort ended it quietly (`done: true`). The fetch transport's cancellation error now also carries code `ABORTED`.
