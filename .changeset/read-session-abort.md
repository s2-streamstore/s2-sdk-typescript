---
"@s2-dev/streamstore": patch
---

Read sessions honour their `signal` the same way on both transports: once it aborts, before `readSession()`, during setup or while waiting at the tail, the session ends with an `S2Error` with code `ABORTED` (status 499) and is not retried. Previously an s2s read session missed an abort that came before its HTTP/2 stream was set up, so a session following the tail waited forever, and a later abort ended it quietly (`done: true`). Any request cancelled through its `signal`, including by `AbortSignal.timeout()`, now fails with this same error; before, cancelled requests carried no code, and timeouts had status 0.

**Note:** on s2s, the default transport on Node, a `for await` loop over a read session now throws this error when the session's signal aborts, instead of ending. Catch `ABORTED` where you abort. Leaving the loop with `break` or `return` right after calling `abort()` still ends it quietly.
