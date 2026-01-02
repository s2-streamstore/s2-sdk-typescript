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

1. Make a request using the SDK client.

<!-- snippet:start getting-started -->
```ts
import { S2, S2Environment, S2Error } from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to talk to S2.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN so we know which basin to inspect.");
}

const streamName = process.env.S2_STREAM ?? "docs/getting-started";

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
});

// List all of the basins the token can see.
const basins = await s2.basins.list();
console.log(
	"My basins:",
	basins.basins.map((basin) => basin.name),
);

const basin = s2.basin(basinName);

// Create a stream for the walkthrough if it does not already exist.
await basin.streams.create({ stream: streamName }).catch((error) => {
	if (!(error instanceof S2Error && error.status === 409)) {
		throw error;
	}
});

const stream = basin.stream(streamName);
const tail = await stream.checkTail();
console.log("Tail for %s/%s:", basinName, streamName);
console.dir(tail, { depth: null });
```
<!-- snippet:end getting-started -->

> Tip: every snippet in this README reads `S2_ACCESS_TOKEN`, `S2_BASIN`, and `S2_STREAM` (with sensible defaults) and comes directly from the runnable files in `examples/`, so you can run them with `npx tsx examples/<file>.ts`.

### Configuration and retries

The `S2` client and stream sessions support configurable retry behavior:

- Configure global retry behavior when constructing `S2`:

<!-- snippet:start retry-config -->
```ts
import { S2, S2Environment, S2Error } from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to configure the SDK.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN so we know which basin to inspect.");
}

const streamName = process.env.S2_STREAM ?? "docs/client-config";

// Global retry config applies to every stream/append/read session created via this client.
const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
	retry: {
		maxAttempts: 3,
		minDelayMillis: 100,
		maxDelayMillis: 500,
		appendRetryPolicy: "all",
		requestTimeoutMillis: 5_000,
	},
});

const basin = s2.basin(basinName);
await basin.streams.create({ stream: streamName }).catch((error: unknown) => {
	if (!(error instanceof S2Error && error.status === 409)) {
		throw error;
	}
});

const stream = basin.stream(streamName);
const tail = await stream.checkTail();
console.log("Tail info:");
console.dir(tail, { depth: null });
```
<!-- snippet:end retry-config -->

- Stream append/read sessions created from `S2.basin(...).stream(...)` inherit this retry configuration.
- The `appendRetryPolicy` dictates how failed appends should be retried. If you are not using a concurrency control like `matchSeqNum`, then retrying a failed append could result in duplicate data, depending on the nature of the failure. This policy can be set to tolerate potential duplicates by retrying all failures (`"all"`, the default) or only failures guaranteed not to have had a side effect (`"noSideEffects"`). If you cannot tolerate potential duplicates and do not have explicit deduplication downstream, consider using `"noSideEffects"` instead of the default.

See the generated API docs for the full description of `RetryConfig`, `AppendRetryPolicy` and `AppendSessionOptions`.

### Append sessions

The `AppendSession` represents a session for appending batches of records to a stream. There are two ways of interacting with an append session:
- via `submit(...)`, which returns a `Promise<AppendAck>` that resolves when the batch is acknowledged by S2.
- via the session's `.readable` and `.writable` streams (`ReadableStream<AppendAck>` / `WritableStream<AppendArgs>`).

You obtain an append session from a stream via:

<!-- snippet:start append-session-create -->
```ts
import {
	AppendInput,
	AppendRecord,
	S2,
	S2Environment,
	S2Error,
} from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to run the append-session example.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN so we know which basin to use.");
}

const streamName = process.env.S2_STREAM ?? "docs/append-session";

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
});

const basin = s2.basin(basinName);
await basin.streams.create({ stream: streamName }).catch((error: unknown) => {
	if (!(error instanceof S2Error && error.status === 409)) {
		throw error;
	}
});

const stream = basin.stream(streamName);
const session = await stream.appendSession({
	maxInflightBytes: 2 * 1024 * 1024,
});

try {
	// Submit a batch; you can enqueue multiple batches before awaiting acks.
	const ticket = await session.submit(
		AppendInput.create([
			AppendRecord.string({ body: "append session example" }),
		]),
	);
	const ack = await ticket.ack();
	console.log(
		"Acked batch covering seqNums %d-%d",
		ack.start.seqNum,
		ack.end.seqNum,
	);
} finally {
	await session.close();
}
```
<!-- snippet:end append-session-create -->

All batches submitted to the same append session will be made durable in the same order as they are submitted, regardless of which method is used. Batches _can_ be duplicated, however, depending on the `appendRetryPolicy` used.

#### Transports

The append session supports two transports:
- One based on `fetch`
- Another which uses our custom [`s2s` protocol](https://s2.dev/docs/rest/records/overview#s2s-spec) over HTTP/2.

When possible, the `s2s` protocol is preferred as it allows for safe pipelining of concurrent appends over the same session, while still enforcing ordering across batches. This can't be guaranteed with the `fetch`-based transport, so it will not pipeline writes (effectively meaning there can only be one inflight, unacknowledged append at a time, thus limiting throughput).

This SDK will attempt to detect whether `s2s` can be used (if the runtime has `node:http2` support), and select a transport accordingly. The transport detection also be overridden via the `forceTransport` option when creating a stream client:

<!-- snippet:start force-transport -->
```ts
import {
	AppendInput,
	AppendRecord,
	S2,
	S2Environment,
	S2Error,
} from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to select a transport.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN so we know which basin to inspect.");
}

const streamName = process.env.S2_STREAM ?? "docs/force-transport";

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
});

const basin = s2.basin(basinName);
await basin.streams.create({ stream: streamName }).catch((error: unknown) => {
	if (!(error instanceof S2Error && error.status === 409)) {
		throw error;
	}
});

// Override the automatic transport detection to force the fetch transport.
const stream = basin.stream(streamName, {
	forceTransport: "s2s",
});

const appendSession = await stream.appendSession({
	maxInflightBytes: 1024 * 1024 * 2,
});

let submitTickets = [];
for (let i = 0; i < 1000; i++) {
	console.log("Submitting record %d", i);
	const ticket = await appendSession.submit(
		AppendInput.create([AppendRecord.string({ body: `${i}` })]),
	);
	submitTickets.push(ticket.ack());
}
console.log("Awaiting durability.");
let durable = await Promise.all(submitTickets);
for (const ack of durable) {
	console.dir(ack, { depth: null });
}

await appendSession.close();
await stream.close();
```
<!-- snippet:end force-transport -->

#### Backpressure

Only writing via `WritableStream` reflects backpressure. A `write(...)` call will resolve as soon as the batch is enqueued for transmission, and will block until there is capacity.

Enqueuing a batch means that the session has accepted the batch, and that it is now inflight. It _doesn't_ mean that the batch has been acknowledged by S2. Because of this, if using `WritableStream`, you should also make sure to `close()` the session, as otherwise you may miss a failure. Only after closing the writer without error can the upstream contents be considered to have been safely appended to the stream.

The `AppendSession` controls how many batches can be inflight at a given time, which is the origin of backpressure. This can be configured by setting either `maxInflightBatches` or `maxInflightBytes` on `AppendSessionOptions`. Writes will block until there is capacity, thus exerting backpressure on upstream writers.


## High-level Guides

### Producer API (TODO)

- [ ] Add narrative docs that explain when to reach for `Producer` versus sending `AppendInput` batches manually.
- [ ] Walk through how batching, per-record acknowledgements, and application-level ids map together.
- [ ] Document error propagation and how `.readable`/`.writable` streams interact with backpressure.

<!-- snippet:start producer-basic -->
```ts
import {
	AppendRecord,
	BatchTransform,
	Producer,
	S2,
	S2Environment,
	S2Error,
} from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to a valid access token.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN before running the producer example.");
}

const streamName = process.env.S2_STREAM ?? "producer/demo";

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
	retry: {
		// Producer can safely retry all batches because it maintains matchSeqNum.
		appendRetryPolicy: "all",
	},
});

const basin = s2.basin(basinName);
try {
	await basin.streams.create({ stream: streamName });
	console.log("Created stream:", streamName);
} catch (error: unknown) {
	if (error instanceof S2Error && error.status === 409) {
		console.log("Stream already exists:", streamName);
	} else {
		throw error;
	}
}

const stream = basin.stream(streamName);
const tail = await stream.checkTail();

const producer = new Producer(
	new BatchTransform({
		lingerDurationMillis: 25,
		maxBatchRecords: 200,
		matchSeqNum: tail.tail.seqNum,
	}),
	await stream.appendSession({
		maxInflightBytes: 4 * 1024 * 1024,
	}),
);

const tickets = [];
for (let i = 0; i < 10; i += 1) {
	const ticket = await producer.submit(
		AppendRecord.string({
			body: `record-${i}`,
		}),
	);
	tickets.push(ticket);
}

const acks = await Promise.all(tickets.map((ticket) => ticket.ack()));
for (const ack of acks) {
	console.log("Record durable at seqNum:", ack.seqNum());
}

// Use the seqNum of the third ack as a coordinate for reading it back.
let record3 = await stream.read({
	start: { from: { seqNum: acks[3].seqNum() } },
	stop: { limits: { count: 1 } },
});
console.dir(record3, { depth: null });

await producer.close();
```
<!-- snippet:end producer-basic -->

### Access Tokens (TODO)

- [ ] Clarify how scopes map to basins/streams, including practical prefix patterns.
- [ ] Document when to use `autoPrefixStreams` vs. explicit prefixes.
- [ ] Cover token lifecycle automation (rotation, least-privilege presets).

<!-- snippet:start access-token -->
```ts
import {
	AppendInput,
	AppendRecord,
	S2,
	S2Environment,
	S2Error,
} from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to a valid access token.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN to point at your working basin.");
}

const adminClient = new S2({
	...S2Environment.parse(),
	accessToken,
});

// Issue a read-only token scoped to the entire account.
const readOnly = await adminClient.accessTokens.issue({
	id: `ts-example-read-only-${Date.now()}`,
	scope: {
		opGroups: {
			stream: { read: true },
		},
	},
	expiresAt: new Date(Date.UTC(2026, 5)),
});
console.log("Read-only token:", readOnly.accessToken);

// Next, issue a token confined to our basin and a stream prefix.
const granular = await adminClient.accessTokens.issue({
	id: `ts-example-granular-${Date.now()}`,
	scope: {
		basins: { exact: basinName },
		streams: { prefix: "tenant-a/" },
		ops: ["append", "create-stream", "list-streams"],
	},
	autoPrefixStreams: true,
});
console.log("Prefixed token:", granular.accessToken);

// Demonstrate how autoPrefixStreams rewrites names for the caller.
// We'll create a new S2 client using the token.
const tenantAClient = new S2({ accessToken: granular.accessToken });
const logicalStreamClient = tenantAClient.basin(basinName).stream("new-stream");

await logicalStreamClient.append(
	AppendInput.create([AppendRecord.string({ body: "scoped append" })]),
);

try {
	const batch = await logicalStreamClient.read({
		start: { from: { seqNum: 0 } },
	});
	console.dir(batch, { depth: null });
} catch (error: unknown) {
	if (error instanceof S2Error && error.status === 403) {
		console.log("Read failed because the token lacked read permission.");
	} else {
		throw error;
	}
}

const tenantAList = await tenantAClient.basin(basinName).streams.list();
console.log("List of streams viewed from tenant-a client:");
console.dir(tenantAList, { depth: null });

const adminList = await adminClient.basin(basinName).streams.list();
console.log("List of streams viewed from admin client:");
console.dir(adminList, { depth: null });

// Show all example tokens and clean them up to avoid clutter.
const tokensToRevoke = await adminClient.accessTokens.list({
	prefix: "ts-example-",
});
for (const token of tokensToRevoke.accessTokens) {
	console.log("Revoking token: %s", token.id);
	console.dir(token, { depth: null });
	await adminClient.accessTokens.revoke({ id: token.id });
}
```
<!-- snippet:end access-token -->

### Raw Append Sessions (TODO)

- [ ] Expand on `AppendSession.submit`, `.readable`, and `.writable`, including lifecycle expectations for `close()` and failure handling.
- [ ] Detail retry semantics (`appendRetryPolicy`, `matchSeqNum`, fencing tokens) with diagrams.
- [ ] Provide a snippet that demonstrates manual batching plus conditional appends.

### Read Sessions (TODO)

- [ ] Cover `start`, `stop`, `clamp`, and `tailOffset` ergonomics with diagrams for replay vs. tailing workloads.
- [ ] Document best practices for cancellation, deduplication, and composing with the patterns package.
- [ ] Add troubleshooting pointers for 416 responses and how `nextReadPosition()` / `lastObservedTail()` evolve.

Core loop:

<!-- snippet:start read-session-loop -->
```ts
const readSession = await stream.readSession(
	{
		start: { from: { tailOffset: 100 } },
		stop: { wait: 30 },
	},
	{ as: "bytes" },
);

const reader = readSession.getReader();

try {
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}

		console.log(`[read] seq=${value.seqNum}`, value.body);
		console.log(
			"next position:",
			readSession.nextReadPosition()?.seqNum ?? "unknown",
		);
	}
} finally {
	reader.releaseLock();
	await readSession.cancel("done");
}
//
```
<!-- snippet:end read-session-loop -->

<!-- snippet:start read-session-basic -->
```ts
import { S2, S2Environment, S2Error } from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to run the read session example.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN so we know which basin to use.");
}

const streamName = process.env.S2_STREAM ?? "docs/read-session";

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
});

const basin = s2.basin(basinName);
await basin.streams.create({ stream: streamName }).catch((error: unknown) => {
	if (!(error instanceof S2Error && error.status === 409)) {
		throw error;
	}
});

const stream = basin.stream(streamName);

// snippet-region read-session-body start
const readSession = await stream.readSession(
	{
		start: { from: { tailOffset: 100 } },
		stop: { wait: 30 },
	},
	{ as: "bytes" },
);

const reader = readSession.getReader();

try {
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}

		console.log(`[read] seq=${value.seqNum}`, value.body);
		console.log(
			"next position:",
			readSession.nextReadPosition()?.seqNum ?? "unknown",
		);
	}
} finally {
	reader.releaseLock();
	await readSession.cancel("done");
}
// snippet-region read-session-body end
```
<!-- snippet:end read-session-basic -->

## Examples

This repo is a small monorepo with:

- Core SDK package: `@s2-dev/streamstore` in `packages/streamstore`
- Optional patterns package: `@s2-dev/streamstore-patterns` in `packages/patterns`

The runnable, literate examples that feed this README now live under [`examples/`](https://github.com/s2-streamstore/s2-sdk-typescript/tree/main/examples). Run any of them with:

```bash
export S2_ACCESS_TOKEN="<YOUR ACCESS TOKEN>"
export S2_BASIN="<YOUR BASIN>"
export S2_STREAM="<YOUR STREAM>" # optional per example
npx tsx examples/<example_name>.ts
```

The legacy example folders under `packages/streamstore/examples` and `packages/patterns/examples` are still around for deeper dives while we migrate everything over.

### Example: Appending and Reading Data

<!-- snippet:start quick-start -->
```ts
import {
	AppendInput,
	AppendRecord,
	S2,
	S2Environment,
	S2Error,
} from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to run the quick-start example.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN so we know which basin to use.");
}

const streamName = process.env.S2_STREAM ?? "docs/quick-start";

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
});

const basin = s2.basin(basinName);
await basin.streams.create({ stream: streamName }).catch((error: unknown) => {
	if (!(error instanceof S2Error && error.status === 409)) {
		throw error;
	}
});

const stream = basin.stream(streamName);

// Make a single append call; the promise resolves when the data is durable.
const ack = await stream.append(
	AppendInput.create([
		AppendRecord.string({
			body: "Hello from the docs snippet!",
			headers: [["content-type", "text/plain"]],
		}),
		AppendRecord.bytes({
			body: new TextEncoder().encode("Bytes payload"),
		}),
	]),
);

console.log(
	`Appended records ${ack.start.seqNum} through ${ack.end.seqNum}. Tail is now ${ack.tail.seqNum}.`,
);

// Read the two records back as bytes.
const batch = await stream.read(
	{
		start: { from: { seqNum: ack.start.seqNum } },
		stop: { limits: { count: 2 } },
	},
	{ as: "bytes" },
);

for (const record of batch.records) {
	console.log(`[read] ${record.seqNum}:`, record.body);
}
```
<!-- snippet:end quick-start -->

>
> You might want to update the basin name in the examples before running since
> basin names are globally unique and each example uses the same basin name
> (`"my-favorite-basin"`).

## Patterns 

This repo also contains a package of more opinionated patterns and types for building around S2. This is available as `@s2-dev/streamstore-patterns`, and located in `packages/patterns`.

See the [README](packages/patterns) in the package for more, as well as examples of how to create a typed client for use with AI SDK.

<!-- snippet:start patterns-serialization -->
```ts
import { openai } from "@ai-sdk/openai";
import { S2, S2Environment, S2Error } from "@s2-dev/streamstore";
import { serialization } from "@s2-dev/streamstore-patterns";
import { streamText } from "ai";

type AiStreamChunk = {
	role: "assistant" | "user";
	content: string;
};

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to run the patterns example.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN so we know which basin to use.");
}

const streamName = process.env.S2_STREAM ?? "docs/patterns-serialization";

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
	retry: {
		maxAttempts: 10,
		minDelayMillis: 100,
		appendRetryPolicy: "all",
	},
});

const basin = s2.basin(basinName);
await basin.streams.create({ stream: streamName }).catch((error: unknown) => {
	if (!(error instanceof S2Error && error.status === 409)) {
		throw error;
	}
});

const appendSession = await basin.stream(streamName).appendSession();

const textEncoder = new TextEncoder();
const appender = new serialization.SerializingAppendSession<AiStreamChunk>(
	appendSession,
	(msg: AiStreamChunk) => textEncoder.encode(JSON.stringify(msg)),
);

const modelStream = await streamText({
	model: openai("gpt-4o-mini"),
	prompt: "Tell me who has the most beautiful durable stream API in the land.",
});

const [forUI, forS2] = modelStream.textStream
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

const s2Pipe = forS2.pipeTo(appender);

const uiReader = forUI.getReader();
try {
	while (true) {
		const { done, value } = await uiReader.read();
		if (done) {
			break;
		}
		console.log(value);
	}
} finally {
	uiReader.releaseLock();
}

await s2Pipe;
```
<!-- snippet:end patterns-serialization -->

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

### Maintaining documentation snippets

- Run `bun run snippets` whenever you touch `README.md` or the snippet source files under `examples/`.
- `bun run check:snippets` (also part of `bun run check`) type-checks every example so regressions are caught in CI.
- Snippet blocks in markdown are delimited by `<!-- snippet:start NAME -->` / `<!-- snippet:end NAME -->`; never edit the generated code directly – update the matching file in `examples/` instead.

## Reach out to us

Join our [Discord](https://discord.gg/vTCs7kMkAf) server. We would love to hear
from you.

You can also email us at [hi@s2.dev](mailto:hi@s2.dev).
