# s2-typescript-patterns

Add-on patterns and higher-level helpers built on top of the [`@s2-dev/streamstore` TypeScript SDK](https://github.com/s2-streamstore/s2-sdk-typescript).

## Installation

```bash
npm install @s2-dev/streamstore-patterns @s2-dev/streamstore
# or: pnpm add @s2-dev/streamstore-patterns @s2-dev/streamstore
# or: yarn add @s2-dev/streamstore-patterns @s2-dev/streamstore
```

## Structure

- `src/patterns`: Reusable patterns/add-ons that wrap or compose types from `@s2-dev/streamstore`.
- `src/index.ts`: Package entrypoint that re-exports everything from `src/patterns`.
- `examples`: Small, focused usage examples that can combine any of the patterns.

### Try the examples

In a loop, synchronously write a message to a stream and read it back.

```bash
export DEBUG="patterns:*"
export S2_ACCESS_TOKEN="token"
export S2_BASIN="your-basin"
S2_STREAM="test/read-write/0001" npx tsx packages/patterns/examples/read-write.ts
```

Use the AI SDK to generate a response to a prompt. Tee the resulting `textStream` to the console and an s2 stream. Then, read through the s2 stream to replay the stream. 

```bash
export DEBUG="patterns:*"
export S2_ACCESS_TOKEN="token"
export S2_BASIN="your-basin"

S2_STREAM="agent/session/0001" npx tsx packages/patterns/examples/ai-sdk.ts
```

## Typed append/read sessions 

The main `@s2-dev/streamstore` SDK provides idiomatic access to the core S2 APIs, as well as functionality like retries.

This package, on the other hand, provides some basic implementations of advanced functionality that can be built off of the core SDK. These may be useful out of the box, or could serve simply as examples for building a system on top of S2. 

### What type of functionality?

The core S2 API essentially provides durable streams of binary records, each of which may not exceed 1MiB. Furthermore, while retries can be configured on the core SDK, retrying failed appends (without first inspecting the stream) can result in duplicate records.

The `SerializingAppendSession<Message>` and `DeserializingReadSession<Message>` patterns provide an opinionated way to address all of these issues, by:
- Being strongly typed around a `Message`
- Splitting large messages into < 1MiB chunks, and "framing" those messages across multiple S2 records
- Injecting deduplication headers (`_dedupe_seq`, `_writer_id`), to act as idempotency keys and allow readers to efficiently detect and filter repeated records caused by retried appends

**Write path (append):**

- `Message` → `Uint8Array` – you supply a serializer (e.g. JSON, MessagePack).
- `Uint8Array` → `Uint8Array[]` – `chunkBytes` splits into bounded-size chunks (`MAX_CHUNK_BODY_BYTES`) so each S2 record stays under the per-record limit.
- `Uint8Array[]` → `AppendRecord[]` – `frameChunksToRecords` adds framing headers (`_frame_bytes`, `_frame_records`) to the first record to describe the whole message.
- `AppendRecord[]` → `AppendRecord[]` with `_dedupe_seq` and `_writer_id` – `injectDedupeHeaders` adds a monotonically increasing dedupe sequence per record, scoped to a unique writer id.
- `AppendRecord[]` → sent to S2 – `SerializingAppendSession` submits each record, optionally using `matchSeqNum` sequencing.

**Read path (consume):**

- S2 records → `ReadSession<"bytes">` – provided by the `@s2-dev/streamstore` SDK.
- Records → filtered records – `DedupeFilter` drops duplicates based on the pair (`_writer_id`, `_dedupe_seq`).
- Filtered records → `CompletedFrame` – `FrameAssembler` uses `_frame_bytes` / `_frame_records` to reassemble full payloads.
- `CompletedFrame.payload` (`Uint8Array`) → `Message` – you supply a deserializer.
- Messages → `ReadableStream<Message>` – `DeserializingReadSession` wraps the read session and yields typed messages.

All of these are grouped under the `serialization` namespace.

## Usage (library)

```ts
import { serialization } from "@s2-dev/streamstore-patterns";
import { S2 } from "@s2-dev/streamstore";
// Serializer/deserializer (bring your own; MessagePack shown here)
import { encode, decode } from "@msgpack/msgpack";

type ChatMessage = {
  userId: string;
  text: string;
};

async function main() {
  const s2 = new S2({ accessToken: process.env.S2_ACCESS_TOKEN! });
  const stream = s2.basin("your-basin").stream("your-stream");

  // Write: serialize, chunk, frame, dedupe, and append.
  const appendSession = new serialization.SerializingAppendSession<ChatMessage>(
    await stream.appendSession(),
    (msg) => encode(msg),
    { dedupeSeq: 0n },
  );

  await appendSession.submit({ userId: "alice", text: "hello" });

  // Read: dedupe, reassemble frames, and deserialize.
  const readSession = new serialization.DeserializingReadSession<ChatMessage>(
    await stream.readSession({ tail_offset: 0, as: "bytes" }),
    (bytes) => decode(bytes) as ChatMessage,
  );

  for await (const msg of readSession) {
    console.log(`[${msg.userId}] ${msg.text}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

### Using WritableStream for streaming sources

`SerializingAppendSession` is also a `WritableStream<Message>`, so you can pipe any `ReadableStream<Message>` into S2 with backpressure:

```ts
const append = new serialization.SerializingAppendSession<ChatMessage>(
  await stream.appendSession({ maxInflightBatches: 10 }),
  (msg) => encode(msg),
  { dedupeSeq: 0n },
);

// readableMessages: ReadableStream<ChatMessage>
await readableMessages.pipeTo(append);
// If this resolves without throwing, the entire stream was durably appended.
```
