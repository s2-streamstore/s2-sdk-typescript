---
"@s2-dev/streamstore": patch
---

Fix append session error classification after retries run out. Batches still in flight now fail with `AppendIndefiniteFailureError` when an earlier attempt may have taken effect, as documented, and batches submitted after the session failed get the plain final error, since they were never sent.
