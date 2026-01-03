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

This repo contains the official TypeScript SDK for [S2](https://s2.dev), a serverless data store for streams, built on the service's [REST API](https://s2.dev/docs/rest/protocol).

**Offramps**
- Runnable examples: `examples/`
- Patterns package: `packages/patterns/README.md`
- SDK type docs (JSDoc/TypeDoc): `https://s2-streamstore.github.io/s2-sdk-typescript/`
- S2 REST docs: `https://s2.dev/docs/rest/protocol`

## Install

```bash
npm add @s2-dev/streamstore
# or
yarn add @s2-dev/streamstore
# or
bun add @s2-dev/streamstore
```

## Quick start

<!-- snippet:start quick-start -->
```ts
import {
	AppendAck,
	AppendInput,
	AppendRecord,
	S2,
	S2Environment,
} from "@s2-dev/streamstore";

const basinName = process.env.S2_BASIN ?? "my-existing-basin";
const streamName = process.env.S2_STREAM ?? "my-new-stream";

const s2 = new S2({
	...S2Environment.parse(),
	accessToken: process.env.S2_ACCESS_TOKEN ?? "my-access-token",
});

// Create a basin (namespace) client for basin-level operations.
const basin = s2.basin(basinName);

// Make a new stream within the basin, using the default configuration.
const streamResponse = await basin.streams.create({ stream: streamName });
console.dir(streamResponse, { depth: null });

// Create a stream client on our new stream.
const stream = basin.stream(streamName);

// Make a single append call.
const append: Promise<AppendAck> = stream.append(
	// `append` expects an input batch of one or many records.
	AppendInput.create([
		// Records can use a string encoding...
		AppendRecord.string({
			body: "Hello from the docs snippet!",
			headers: [["content-type", "text/plain"]],
		}),
		// ...or contain raw binary data.
		AppendRecord.bytes({
			body: new TextEncoder().encode("Bytes payload"),
		}),
	]),
);

// When the promise resolves, the data is fully durable and present on the stream.
const ack = await append;
console.log(
	`Appended records ${ack.start.seqNum} through ${ack.end.seqNum} (exclusive).`,
);
console.dir(ack, { depth: null });

// Read the two records back as binary.
const batch = await stream.read(
	{
		start: { from: { seqNum: ack.start.seqNum } },
		stop: { limits: { count: 2 } },
	},
	{ as: "bytes" },
);

for (const record of batch.records) {
	console.dir(record, { depth: null });
	console.log("decoded body: %s", new TextDecoder().decode(record.body));
}
```
<!-- snippet:end quick-start -->

## Development

Run examples:

```bash
export S2_ACCESS_TOKEN="<token>"
export S2_BASIN="<basin>"
export S2_STREAM="<stream>" # optional per example
npx tsx examples/<example>.ts
```

Run tests:

```bash
bun run test
```

Run the browser example (from the core package):

```bash
bun run --cwd packages/streamstore example:browser
```

## Data plane

### Records and batches (unary append)

Appends are **batched**: the atomic unit of append is an `AppendInput` (a batch of records).

<!-- snippet:start data-plane-unary -->
```ts
// Append a mixed batch: string + bytes with headers.
console.log("Appending two records (string + bytes).");
const mixedAck = await stream.append(
	AppendInput.create([
		AppendRecord.string({
			body: "string payload",
			headers: [
				["record-type", "example"],
				["user-id", "123"],
			],
		}),
		AppendRecord.bytes({
			body: new TextEncoder().encode("bytes payload"),
			headers: [[new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]],
		}),
	]),
);
console.dir(mixedAck, { depth: null });
```
<!-- snippet:end data-plane-unary -->

### Append sessions (ordered, stateful appends)

Use an `AppendSession` when you want higher throughput and ordering guarantees:
- It is stateful and enforces that the order you submit batches becomes the order on the stream.
- It supports pipelining submissions while still preserving ordering (especially with the `s2s` transport).

<!-- snippet:start data-plane-append-session -->
```ts
console.log("Opening appendSession with maxInflightBytes=1MiB.");
const appendSession = await stream.appendSession({
	maxInflightBytes: 1024 * 1024,
});

// Demonstrate matchSeqNum by anchoring to the last ack.
const startSeq = mixedAck.end.seqNum;
const appendAck = await appendSession.submit(
	AppendInput.create(
		[
			AppendRecord.string({ body: "session record A" }),
			AppendRecord.string({ body: "session record B" }),
		],
		{ matchSeqNum: startSeq },
	),
);

console.log("Session submit acked range:");
console.dir(await appendAck.ack(), { depth: null });

console.log("Closing append session to flush outstanding batches.");
await appendSession.close();
```
<!-- snippet:end data-plane-append-session -->

### Producer (auto-batching for performance)

Streams are limited in **batches/sec**, not bytes/sec. For throughput, you typically want fewer, larger batches.
`Producer` wraps an append session and auto-batches records (via `BatchTransform`), which is the recommended path for most high-throughput writers.

<!-- snippet:start producer-core -->
```ts
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
<!-- snippet:end producer-core -->

### Read sessions (multi-batch reads and tailing)

Use `readSession()` when you want:
- to read more than a single response batch (responses larger than 1 MiB),
- to keep a session open and tail for new data (omit stop criteria).

<!-- snippet:start read-session-core -->
```ts
const readSession = await stream.readSession({
	start: { from: { tailOffset: 10 }, clamp: true },
	stop: { wait: 10 },
});

for await (const record of readSession) {
	console.log(record.seqNum, record.body);
}
```
<!-- snippet:end read-session-core -->

## Client configuration

### Retries and append retry policy

<!-- snippet:start client-config -->
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
<!-- snippet:end client-config -->

- `appendRetryPolicy: "noSideEffects"` only retries appends that are naturally idempotent via `matchSeqNum`.
- `appendRetryPolicy: "all"` can retry any failure (higher durability, but can duplicate data without idempotency).

### Session transports

Sessions can use either:
- `fetch` (HTTP/1.1)
- `s2s` (S2’s streaming protocol over HTTP/2)

You can force a transport per stream:

<!-- snippet:start force-transport -->
```ts
// Override the automatic transport detection to force the fetch transport.
const stream = basin.stream(streamName, {
	forceTransport: "s2s",
});
```
<!-- snippet:end force-transport -->

## Patterns

For higher-level, more opinionated building blocks (typed append/read sessions, framing, dedupe helpers), see `packages/patterns/README.md`.

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
- To keep snippets small, add region markers to example files: `snippet-region REGION start` / `snippet-region REGION end`.

## Reach out to us

Join our [Discord](https://discord.gg/vTCs7kMkAf) server. We would love to hear
from you.

You can also email us at [hi@s2.dev](mailto:hi@s2.dev).
