---
"@s2-dev/streamstore": patch
---

s2s append sessions write batches in the order they were submitted. With compression on, a batch large enough to compress could be written after a smaller one submitted after it, which reordered records on the stream and failed the session.

Append sessions send a batch as soon as it is submitted, rather than holding it until earlier batches are acked, so s2s pipelines appends.

A batch submitted just as `close()` is called no longer leaves its `ack()` pending forever.
