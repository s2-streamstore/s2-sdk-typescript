// Streams Bluesky posts from Jetstream (firehose) to S2.
// Run with: bun examples/bluesky-firehose-to-s2.ts

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
	throw new Error("Set S2_BASIN before running the Bluesky firehose example.");
}

const streamName = process.env.S2_STREAM ?? "bluesky/posts";

interface JetstreamEvent {
	did: string;
	time_us: number;
	kind: "commit" | "identity" | "account";
	commit?: {
		rev: string;
		operation: "create" | "update" | "delete";
		collection: string;
		rkey: string;
		record?: {
			$type: string;
			text?: string;
			createdAt?: string;
			langs?: string[];
			[key: string]: unknown;
		};
		cid?: string;
	};
}

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
	retry: {
		appendRetryPolicy: "all",
	},
});

const basin = s2.basin(basinName);
await basin.streams.create({ stream: streamName }).catch((error: unknown) => {
	if (error instanceof S2Error && error.status === 409) {
		console.log("Stream already exists:", streamName);
		return;
	}
	throw error;
});

const stream = basin.stream(streamName);

const producer = new Producer(
	new BatchTransform({
		lingerDurationMillis: 50,
		maxBatchRecords: 100,
	}),
	await stream.appendSession(),
);

// Wrap WebSocket in a ReadableStream.
function websocketToReadable(ws: WebSocket): ReadableStream<JetstreamEvent> {
	return new ReadableStream({
		start(controller) {
			ws.onmessage = (event) => {
				controller.enqueue(JSON.parse(event.data as string));
			};
			ws.onerror = (e) => controller.error(e);
			ws.onclose = () => controller.close();
		},
		cancel() {
			ws.close();
		},
	});
}

const jetstreamUrl = new URL("wss://jetstream2.us-east.bsky.network/subscribe");
jetstreamUrl.searchParams.set("wantedCollections", "app.bsky.feed.post");

console.log("Connecting to Bluesky Jetstream...");
const ws = new WebSocket(jetstreamUrl.toString());
await new Promise<void>((resolve, reject) => {
	ws.onopen = () => resolve();
	ws.onerror = (e) => reject(e);
});

console.log("Connected to Bluesky Jetstream");
console.log("Streaming new posts to S2...");
console.log("Press Ctrl+C to stop.\n");

let submitted = 0;
let acked = 0;

// Transform that filters posts and converts to AppendRecord.
const toAppendRecord = new TransformStream<JetstreamEvent, AppendRecord>({
	transform(data, controller) {
		if (
			data.kind !== "commit" ||
			data.commit?.operation !== "create" ||
			data.commit?.collection !== "app.bsky.feed.post" ||
			!data.commit?.record?.text
		) {
			return;
		}
		submitted++;
		controller.enqueue(
			AppendRecord.string({
				body: JSON.stringify(data),
				headers: [
					["content-type", "application/json"],
					["bsky-did", data.did],
					["bsky-rkey", data.commit.rkey],
					["bsky-collection", data.commit.collection],
				],
			}),
		);
	},
});

// Ack loop runs concurrently, tracking acked count.
const ackLoop = (async () => {
	const reader = producer.readable.getReader();
	while (true) {
		const { done } = await reader.read();
		if (done) break;
		acked++;
	}
})();

const logInterval = setInterval(() => {
	console.log(
		`submitted=${submitted} acked=${acked} inflight=${submitted - acked}`,
	);
}, 1000);

// Graceful shutdown on Ctrl+C.
process.on("SIGINT", () => {
	console.log("\nShutting down...");
	ws.close();
});

// Pipe WebSocket -> filter/transform -> S2 producer.
try {
	await websocketToReadable(ws)
		.pipeThrough(toAppendRecord)
		.pipeTo(producer.writable);
	await ackLoop;
} finally {
	clearInterval(logInterval);
	await stream.close();
	console.log(`Final: submitted=${submitted} acked=${acked}`);
}
