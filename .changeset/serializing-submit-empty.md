---
"@s2-dev/streamstore-patterns": patch
---

Reject empty serializations in `SerializingAppendSession` with a clear `S2Error` instead of crashing. Previously a serializer producing zero bytes (e.g. `JSON.stringify(undefined)`) made `submit()` throw an opaque `TypeError` while `write()` threw an `S2Error`; both paths now throw the same `S2Error` explaining that the serializer must produce at least one byte.
