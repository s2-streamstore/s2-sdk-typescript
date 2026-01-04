---
"@s2-dev/streamstore": minor
"@s2-dev/streamstore-patterns": patch
---

- Adds a higher level Producer API which provides a per-record submit and ack interface (while using a configurable batcher over an append session)
- API standardization around append session, in particular by introducing a BatchSubmitTicket type
  - `submit(batch)` returns `Promise<BatchSubmitTicket>`
    - this promise resolves only once a batch has been enqueued for submission in the session, and thus has received a deterministic ordering
    - users can separately await the Promise<AppendAck> returned by `BatchSubmitTicket.ack()` to block on durability
- Switches to use of protobuf content-type for unary data plane requests when appending or reading binary records
  - base64 is still used for SSE read sessions
- Allows explicit closing of an S2Stream, triggering cleanup of shared transport
- Introduces a consolidated, documented SDK type layer including `AppendRecord` factories and `AppendInput.create(...)` validation
- Improves transport/mapping internals: dedicated case-conversion utilities, centralized mappers, and protobuf support for bytes paths
- Expanded docs/examples and test coverage (including retry/session and correctness-focused tests)
