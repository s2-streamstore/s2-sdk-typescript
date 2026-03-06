---
"@s2-dev/streamstore": patch
---

Bug fixes:

- Fix `Producer.close()` to be idempotent, preventing TypeError on concurrent calls (#90)
- Freeze and unexport `Redacted` prototype to prevent secret leakage (#91)
- Re-check closed state after async transport creation in `readSession`/`appendSession` (#96)
- Check all pipelined entries for idempotency under `noSideEffects` retry policy (#135)
- Fix `BatchTransform` cancel hook, 0ms linger, controller init, and safe async flush (#136)
- Use `AppendInput.create` in `SerializingAppendSession.write` for correct `meteredBytes` (#137)
- Await pending ack handlers before exiting `Producer.runPump` (#138)
- Prevent transport leak by caching creation promise in `S2Stream.getTransport` (#140)
- Use exact matching in `isConnectionError` to prevent false positives (#141)
- Clean up goaway and abort listeners in `S2SReadSession` to prevent memory leaks (#142)
- Validate numeric inputs in `AppendRecord.trim` and `AppendInput.create` (#143)
- Fix `EventStream` falsy value drops, missing return after done, and no-colon SSE parsing (#144)
- Count connection failures toward `maxAttempts` in `RetryAppendSession` (#150)
- Recompute `meteredBytes` after injecting dedupe headers (#151)
- Add type guard before `in` operator to handle non-object error responses (#154)
