---
"@s2-dev/streamstore": patch
---

Floor fractional millisecond timestamps in the protobuf append encoder, matching the JSON path. Previously a record with a fractional `timestamp` (e.g. `performance.timeOrigin + performance.now()`) threw a `RangeError` from `BigInt()` inside the s2s transport, which crashed the append session's retry pump and left every `ticket.ack()` pending forever. The s2s transport now also reports any encoder failure as a failed append result instead of a rejected promise.
