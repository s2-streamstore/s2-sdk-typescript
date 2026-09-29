---
"@s2-dev/streamstore": patch
---

Fix `RetryAppendSession` to forward the final attempt error's `origin` (and `data`) when constructing the `Max attempts exhausted` error. Previously the fresh `S2Error` defaulted `origin` to `"sdk"`, so `hasNoSideEffects()` evaluated under SDK-origin rules and `withPriorUncertainty` never wrapped the error into `AppendIndefiniteFailureError` when retries were exhausted on a retryable definite server error (e.g. `429 rate_limited`) after an earlier indefinite attempt. Callers and `failureCause()` now correctly receive `AppendIndefiniteFailureError` (exposing `finalAttemptError`/`cause`), matching the unary append path.
