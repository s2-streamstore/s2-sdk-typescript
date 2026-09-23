---
"@s2-dev/streamstore": patch
---

Preserve uncertainty across append retries. If an earlier attempt may have taken effect and the final attempt fails with an error that would otherwise report `hasNoSideEffects() === true`, unary appends and append sessions now fail with `AppendIndefiniteFailureError`, which exposes the final attempt's error as `finalAttemptError` (and `cause`) while reporting `hasNoSideEffects() === false` for the whole append.
