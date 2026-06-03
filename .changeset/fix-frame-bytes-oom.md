---
"@s2-dev/streamstore-patterns": patch
---

fix: cap declared frame size to prevent reader OOM from untrusted `_frame_bytes` (#230)

`FrameAssembler` allocated its reassembly buffer directly from the attacker-controlled
`_frame_bytes` header, so a tiny record declaring a huge frame could force a reader to
eagerly allocate that much memory. Frames whose declared size is non-positive or exceeds
`maxFrameBytes` (default 100 MiB) are now dropped before allocating. The limit is
configurable via `FrameAssembler`'s constructor and `DeserializingReadSession`'s
`maxFrameBytes` option.
