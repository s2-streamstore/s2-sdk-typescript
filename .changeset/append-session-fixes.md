---
"@s2-dev/streamstore": patch
---

s2s append sessions write batches in the order they were submitted. With compression on, a batch large enough to compress could be written after a smaller one submitted after it, which reordered records on the stream and failed the session.

Append sessions send a batch as soon as it is submitted, rather than holding it until earlier batches are acked, so s2s pipelines appends.

When an s2s append timed out while its HTTP/2 stream was still opening, the abandoned attempt could still write it once the stream opened, so the retry appended it twice, even under `appendRetryPolicy: "noSideEffects"` (#364).

An append session whose transport fails an append by throwing now fails with that error, rather than hanging with no error.

A batch submitted just as `close()` is called no longer leaves its `ack()` pending forever.
