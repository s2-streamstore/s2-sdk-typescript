---
"@s2-dev/streamstore": patch
---

Make append-session bookkeeping O(1) per ack instead of O(queue depth): replace array `shift()` with an amortized O(1) FIFO queue (inflight batches, capacity waiters, pending acks), and drain new submissions from a dedicated queue instead of rescanning the full inflight queue every pump cycle. At ~30k queued batches this cuts client CPU for a 100k-append session from ~142s to ~7.5s.
