---
"@s2-dev/streamstore": patch
---

Act on s2s reconnect advice once per minute, keep terminal `server_draining` reconnects outside the ordinary retry budget, and drop draining connections from the pool. Read sessions now anchor a timestamp or tail-relative start to the tail of an empty batch, so a reconnect resumes from the caught-up position instead of re-evaluating the original start against a newer tail.
