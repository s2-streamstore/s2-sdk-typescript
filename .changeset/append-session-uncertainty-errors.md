---
"@s2-dev/streamstore": patch
---

Append sessions now fail with `AppendIndefiniteFailureError` when retries run out on a server error like `rate_limited` after an earlier attempt may have taken effect, as documented. Previously the "Max attempts exhausted" error dropped the server origin, so it was never wrapped.
