---
"@s2-dev/streamstore": patch
---

Make append-session bookkeeping O(1) per ack instead of O(queue depth): replace array `shift()` with an amortized O(1) FIFO queue (inflight batches, capacity waiters, pending acks), and drain new submissions from a dedicated queue instead of rescanning the full inflight queue every pump cycle.
