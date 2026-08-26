---
"@s2-dev/streamstore": patch
---

Act on s2s reconnect advice: sessions move to a fresh connection when a server starts draining, and the pooled connection the advice arrived on is dropped so no new stream reuses it.
