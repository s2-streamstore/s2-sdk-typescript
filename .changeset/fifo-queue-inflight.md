---
"@s2-dev/streamstore": patch
---

Replace array `shift()` with an O(1) amortized FIFO queue for inflight batches, capacity waiters, and pending acks. Avoids quadratic behavior when many small batches are queued (hundreds of thousands of entries fit within the default 3 MiB `maxInflightBytes`).
