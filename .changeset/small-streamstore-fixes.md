---
"@s2-dev/streamstore": patch
---

`AppendInput.create` rejects a record whose `meteredBytes` is not a non-negative integer, or whose `timestamp` is not a valid `Date` or a non-negative number of milliseconds up to `Number.MAX_SAFE_INTEGER`. Before, a hand-built record with a missing or `NaN` `meteredBytes` let an append session send only one batch at a time from then on, and an invalid timestamp was dropped on the fetch transport and threw a non-`S2Error` on s2s. A `null` timestamp still means no timestamp, now on s2s as well as fetch.

`Producer.submit` rejects such a record on its own, rather than letting it fail the batch it would join. An append session rejects a hand-built `AppendInput` whose `meteredBytes` is not a non-negative integer.

s2s sessions build request paths without a double slash when the endpoint ends with `/`, such as `https://host/v1/`.

Errors a fetch read session gets from the server have `origin: "server"` instead of `"sdk"`.

Disposing a read session (`await using`, or `[Symbol.asyncDispose]()`) while a reader holds it ends the session, failing that reader's pending read with `ABORTED`. Before, it threw "ReadableStream is locked" and left the session open.

`EncryptionKey.from` rejects a string key that is not standard, padded base64 with an `EncryptionKeyFormatError`, whose message does not include the key.
