---
"@s2-dev/streamstore": minor
---

Add `streamConfig` to `AppendInput`, `ReadInput`, and `AppendSessionOptions`. It is sent as the `s2-stream-config` header and applied, over the basin's default stream configuration, only when the append or read auto-creates the stream; it is ignored if the stream already exists. Sessions resend it on every connect.
