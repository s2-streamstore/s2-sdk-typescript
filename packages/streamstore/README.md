# @s2-dev/streamstore

TypeScript SDK for [S2](https://s2.dev), a serverless data store for streams.

This package is the core client for S2's [REST API](https://s2.dev/docs/rest/protocol), providing an ergonomic interface for appending to streams and reading data from them.

## Installation

```bash
npm add @s2-dev/streamstore
# or
yarn add @s2-dev/streamstore
# or
bun add @s2-dev/streamstore
```

## Quick start

Generate an access token from the S2 console at <https://s2.dev/dashboard>, then:

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

> Tip: snippets look for `S2_ACCESS_TOKEN`, `S2_BASIN`, and `S2_STREAM` so you can run them with `npx tsx examples/<file>.ts`.

## More documentation

- Full SDK overview and additional examples: see the root repo README at <https://github.com/s2-streamstore/s2-sdk-typescript>.
- S2 service docs: <https://s2.dev/docs>.
