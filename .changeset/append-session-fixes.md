---
"@s2-dev/streamstore": patch
---

s2s append sessions write batches in the order they were submitted. With compression on, a batch large enough to compress could be written after a smaller one submitted after it, which reordered records on the stream and failed the session.

Append sessions send a batch as soon as it is submitted, rather than holding it until earlier batches are acked, so s2s pipelines appends. Under `appendRetryPolicy: "noSideEffects"`, a session can therefore give up more often when appends without `matchSeqNum` are pipelined: once a later batch may have reached the server, a failed earlier one is not retried.

When an s2s append timed out while its HTTP/2 stream was still opening, the abandoned attempt could still write it once the stream opened, so the retry appended it twice, even under `appendRetryPolicy: "noSideEffects"` (#364).

An append session whose transport fails an append by throwing now fails with that error, rather than hanging with no error.

Batches submitted while others wait for capacity keep their order. Before, a small batch could be enqueued ahead of a larger one submitted before it. A batch larger than `maxInflightBytes` is sent once the session is empty, and fails, rather than waiting forever.

A batch submitted just as `close()` is called no longer leaves its `ack()` pending forever.
