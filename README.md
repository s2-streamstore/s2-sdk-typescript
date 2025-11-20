<div align="center">
  <p>
    <!-- Light mode logo -->
    <a href="https://s2.dev#gh-light-mode-only">
      <img src="https://raw.githubusercontent.com/s2-streamstore/s2-sdk-rust/main/assets/s2-black.png" height="60">
    </a>
    <!-- Dark mode logo -->
    <a href="https://s2.dev#gh-dark-mode-only">
      <img src="https://raw.githubusercontent.com/s2-streamstore/s2-sdk-rust/main/assets/s2-white.png" height="60">
    </a>
  </p>

  <h1>TypeScript SDK for S2</h1>

  <p>
    <!-- npm -->
    <a href="https://www.npmjs.com/package/@s2-dev/streamstore"><img src="https://img.shields.io/npm/v/@s2-dev/streamstore.svg" alt="npm version" /></a>
    <!-- Discord (chat) -->
    <a href="https://discord.gg/vTCs7kMkAf"><img src="https://img.shields.io/discord/1209937852528599092?logo=discord" /></a>
  </p>
</div>

[S2](https://s2.dev) is a serverless data store for streams.

This repo is the official TypeScript SDK, which provides an ergonomic interface over the service's [REST API](https://s2.dev/docs/rest/protocol).

> **Note:** This is a rewrite of the TypeScript SDK. The older version (0.15.3) is still available and can be installed:
> ```bash
> npm add @s2-dev/streamstore@0.15.3
> ```
> The archived repository for the older SDK is available [here](https://github.com/s2-streamstore/s2-sdk-typescript-old).

## S2 Basics

S2 is a managed service that provides unlimited, durable streams.

Streams can be appended to, with all new records added to the tail of the stream. You can read from any portion of a stream – indexing by record sequence number, or timestamp – and follow updates live.

See it in action on the playground (built with this TypeScript SDK): [s2.dev/playground](https://s2.dev/playground).

## SDK

### Getting started

1. Add the `@s2-dev/streamstore` dependency to your project:
   ```bash
   npm add @s2-dev/streamstore
   # or
   yarn add @s2-dev/streamstore
   # or
   bun add @s2-dev/streamstore
   ```

1. Generate an access token by logging onto the web console at
   [s2.dev](https://s2.dev/dashboard).

1. Make a request using SDK client.
   ```typescript
   import { S2 } from "@s2-dev/streamstore";

   const s2 = new S2({
     accessToken: process.env.S2_ACCESS_TOKEN!,
   });

   const basins = await s2.basins.list();
   console.log("My basins:", basins.basins.map((basin) => basin.name));
   ```

### Configuration and retries

The `S2` client and stream sessions support configurable retry behavior:

- Configure global retry behavior when constructing `S2`:

  ```ts
  import { S2 } from "@s2-dev/streamstore";

  const s2 = new S2({
    accessToken: process.env.S2_ACCESS_TOKEN!,
    retry: {
      // Total attempts including the first call (1 = no retries)
      maxAttempts: 3,
      // Base delay (ms) between attempts; jitter is applied
      retryBackoffDurationMillis: 100,
      // Retry policy for append operations (default: "all"; see API docs for details)
      appendRetryPolicy: "all",
      // Maximum time (ms) to wait for an append ack before treating it as failed
      requestTimeoutMillis: 5000,
    },
  });
  ```

- Stream append/read sessions created from `S2.basin(...).stream(...)` inherit this retry configuration.
- The `appendRetryPolicy` dictates how failed appends should be retried. If you are not using a concurrency control like `match_seq_num`, then retrying a failed append could result in duplicate data, depending on the nature of the failure. This policy can be set to tolerate potential duplicates by retrying all failures (`"all"`, the default) or only failures guaranteed not to have had a side effect (`"noSideEffects"`). If you cannot tolerate potential duplicates and do not have explicit deduplication downstream, consider using `"noSideEffects"` instead of the default.

See the generated API docs for the full description of `RetryConfig`, `AppendRetryPolicy` and `AppendSessionOptions`.

### Append sessions

The `AppendSession` represents a session for appending batches of records to a stream. There are two ways of interacting with an append session:
- via `submit(...)`, which returns a `Promise<AppendAck>` that resolves when the batch is acknowledged by S2.
- via the session's `.readable` and `.writable` streams (`ReadableStream<AppendAck>` / `WritableStream<AppendArgs>`).

You obtain an append session from a stream via:

```ts
const session = await stream.appendSession();
```

All batches submitted to the same append session will be made durable in the same order as they are submitted, regardless of which method is used. Batches _can_ be duplicated, however, depending on the `appendRetryPolicy` used.

#### Transports

The append session supports two transports:
- One based on `fetch`
- Another which uses our custom [`s2s` protocol](https://s2.dev/docs/rest/records/overview#s2s-spec) over HTTP/2.

When possible, the `s2s` protocol is preferred as it allows for safe pipelining of concurrent appends over the same session, while still enforcing ordering across batches. This can't be guaranteed with the `fetch`-based transport, so it will not pipeline writes (effectively meaning there can only be one inflight, unacknowledged append at a time, thus limiting throughput).

This SDK will attempt to detect whether `s2s` can be used (if the runtime has `node:http2` support), and select a transport accordingly. The transport detection also be overridden via the `forceTransport` option when creating a stream client:

```typescript
const stream = s2
    .basin("my-basin")
    .stream("my-stream", { forceTransport: "fetch" });
```

#### Backpressure

Only writing via `WritableStream` reflects backpressure. A `write(...)` call will resolve as soon as the batch is enqueued for transmission, and will block until there is capacity.

Enqueuing a batch means that the session has accepted the batch, and that it is now inflight. It _doesn't_ mean that the batch has been acknowledged by S2. Because of this, if using `WritableStream`, you should also make sure to `close()` the session, as otherwise you may miss a failure. Only after closing the writer without error can the upstream contents be considered to have been safely appended to the stream.

The `AppendSession` controls how many batches can be inflight at a given time, which is the origin of backpressure. This can be configured by setting either `maxInflightBatches` or `maxInflightBytes` on `AppendSessionOptions`. Writes will block until there is capacity, thus exerting backpressure on upstream writers.


## Examples

This repo is a small monorepo with:

- Core SDK package: `@s2-dev/streamstore` in `packages/streamstore`
- Optional patterns package: `@s2-dev/streamstore-patterns` in `packages/patterns`

Core SDK examples live under:

- [`packages/streamstore/examples`](https://github.com/s2-streamstore/s2-sdk-typescript/tree/main/packages/streamstore/examples)

Run a core example with:

```bash
export S2_ACCESS_TOKEN="<YOUR ACCESS TOKEN>"
npx tsx packages/streamstore/examples/<example_name>.ts
```

Patterns-specific examples (serialization pipeline, typed client, etc.) live under:

- [`packages/patterns/examples`](https://github.com/s2-streamstore/s2-sdk-typescript/tree/main/packages/patterns/examples)

To use those, first install the optional patterns package alongside the core SDK and then follow the instructions in:

- [`packages/patterns/README.md`](https://github.com/s2-streamstore/s2-sdk-typescript/tree/main/packages/patterns/README.md)

### Example: Appending and Reading Data

```typescript
import { S2, AppendRecord } from "@s2-dev/streamstore";

const s2 = new S2({
  accessToken: process.env.S2_ACCESS_TOKEN!,
});

// Get a basin and stream
const basin = s2.basin("my-basin");
const stream = basin.stream("my-stream");

// Append records
await stream.append([
  AppendRecord.make("Hello, world!", { foo: "bar" }),
  AppendRecord.make(new Uint8Array([1, 2, 3]), { type: "binary" }),
]);

// Read records
const result = await stream.read({
  seq_num: 0,
  count: 10,
});

for (const record of result.records) {
  console.log("Record:", record.body, "Headers:", record.headers);
}

// Stream records with read session
const readSession = await stream.readSession({
  clamp: true,
  tail_offset: 10,
});

for await (const record of readSession) {
  console.log("Streaming record:", record);
}
```

>
> You might want to update the basin name in the examples before running since
> basin names are globally unique and each example uses the same basin name
> (`"my-favorite-basin"`).

## Patterns 

This repo also contains a package of more opinionated patterns and types for building around S2. This is available as `@s2-dev/streamstore-patterns`, and located in `packages/patterns`.

See the [README](packages/patterns) in the package for more, as well as examples of how to create a typed client for use with AI SDK.

```typescript
type AiStreamChunk = {
    role: "assistant" | "user",
    content: string
};

const s2 = new S2({
    accessToken: s2AccessToken,
    retry: {
        maxAttempts: 10,
        retryBackoffDurationMillis: 100,
        appendRetryPolicy: "all",
    },
});

// Create the raw append session.
const appendSession = await s2
    .basin("mega-corp-agent-sessions")
    .stream("session/09b5fb6")
    .appendSession();

const textEncoder = new TextEncoder();

// Use the serializing append session wrapper to add framing,
// type serialization, and deduplication logic.
const appender = new SerializingAppendSession<AiStreamChunk>(
    appendSession,
    (msg) => textEncoder.encode(JSON.stringify(msg)),
);

// Get a stream of tokens from AI SDK.
const modelStream = await streamText({
    model: openai("gpt-4o-mini"),
    prompt: "Tell me who has the most beautiful durable stream API in the land.",
});

// Tee the stream, using one for processing and sending the
// other to S2.
let [forUI, forS2] = modelStream.textStream
    .pipeThrough(
        new TransformStream<string, AiStreamChunk>({
            transform: (text, controller) => {
                controller.enqueue({
                    role: "assistant",
                    content: text,
                });
            },
        }),
    )
    .tee();

let s2Pipe = forS2.pipeTo(appender);

for await (const msg of forUI) {
    // Send messages to your UI.
    console.log(msg);
}

// Ensure the stream is fully saved in S2.
await s2Pipe;
```

## SDK Docs and Reference

For detailed documentation for the SDK, please check the generated type docs [here](https://s2-streamstore.github.io/s2-sdk-typescript/).

For API reference, please visit the [S2 Documentation](https://s2.dev/docs).

## Feedback

We use [Github Issues](https://github.com/s2-streamstore/s2-sdk-typescript/issues) to
track feature requests and issues with the SDK. If you wish to provide feedback,
report a bug or request a feature, feel free to open a Github issue.

### Contributing

Developers are welcome to submit Pull Requests on the repository. If there is
no tracking issue for the bug or feature request corresponding to the PR, we
encourage you to open one for discussion before submitting the PR.

## Reach out to us

Join our [Discord](https://discord.gg/vTCs7kMkAf) server. We would love to hear
from you.

You can also email us at [hi@s2.dev](mailto:hi@s2.dev).
