---
"@s2-dev/streamstore": patch
---

Report a clear protocol error when the S2S transport receives a compressed frame for an algorithm that was never negotiated, instead of the misleading "zlib module has not been loaded".
