---
"@s2-dev/streamstore": patch
---

Allow `close()` to interrupt a persistent `server_draining` / `reconnect_advised` append-session handoff and apply a small bounded backoff between drain handoffs. Previously the pump handed drain errors off with `recover(0)` (zero backoff) and no `closing` check, so on a transport that keeps accepting connections while returning a drain error the pump busy-spun for the whole drain window and `close()` plus outstanding `ticket.ack()` calls hung until the window ended. The planned-handoff retry-budget exemption is preserved.
