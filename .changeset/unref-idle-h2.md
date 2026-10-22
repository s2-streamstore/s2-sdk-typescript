---
"@s2-dev/streamstore": patch
---

Idle pooled HTTP/2 sessions no longer keep the Node process alive, so scripts exit after their sessions close without needing `stream.close()`.
