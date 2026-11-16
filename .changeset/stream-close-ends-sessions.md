---
"@s2-dev/streamstore": minor
---

`S2Stream.close()` ends the sessions opened from the handle and then settles, the same way on both transports. Read sessions end with an `S2Error` with code `ABORTED`, as when their `signal` aborts, and append sessions close as `AppendSession.close()` does. Previously, with a session open, `close()` never settled on s2s when the handle was the endpoint's last user, and otherwise resolved at once while its sessions kept running.

**Breaking:** sessions no longer outlive the handle they were opened from. Finish reading and appending before closing the handle.
