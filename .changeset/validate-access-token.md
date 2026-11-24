---
"@s2-dev/streamstore": patch
---

`new S2()` now throws an `S2Error` if the access token is empty, ends with whitespace, or contains control characters such as a trailing newline. Before, the client was created and every request failed, and an invalid header value could echo the token in the error message.
