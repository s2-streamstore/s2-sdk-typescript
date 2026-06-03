---
"@s2-dev/resumable-stream": patch
---

fix: `persistToS2` now actually invokes `onSeqNumMismatch` (#248)

The per-record `instanceof SeqNumMismatchError` check was unreachable — `Producer.submit()`
wraps a pump failure in a generic `S2Error`, so the callback never fired. The genuine
`SeqNumMismatchError` surfaces from `producer.close()`, so the handling now runs after the
producer is closed: when the persist failure is (or contains) a `SeqNumMismatchError` and an
`onSeqNumMismatch` callback was provided, it's invoked and treated as an expected
fenced/concurrent-writer condition instead of being thrown. Callers without the callback are
unaffected (the failure still throws).
