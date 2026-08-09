---
"@s2-dev/streamstore": patch
---

Prevent S2S read cancellation from enqueuing into a closed stream controller when HTTP/2 closes with a partial frame.
