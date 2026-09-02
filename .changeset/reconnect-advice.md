---
"@s2-dev/streamstore": patch
---

Act on s2s reconnect advice once per minute, keep terminal `server_draining` reconnects outside the ordinary retry budget, and drop draining connections from the pool.
