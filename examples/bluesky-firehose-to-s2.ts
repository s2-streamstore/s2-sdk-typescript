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

const producer = new Producer(
	new BatchTransform({
		lingerDurationMillis: 50,
		maxBatchRecords: 100,
	}),
	await stream.appendSession(),
);

const jetstreamUrl = new URL("wss://jetstream2.us-east.bsky.network/subscribe");
jetstreamUrl.searchParams.set("wantedCollections", "app.bsky.feed.post");

console.log("Connecting to Bluesky Jetstream...");
const ws = new WebSocket(jetstreamUrl.toString());

let submitted = 0;
let acked = 0;
let logInterval: Timer | null = null;

ws.onopen = () => {
	console.log("Connected to Bluesky Jetstream");
	console.log("Streaming new posts to S2...");
	console.log("Press Ctrl+C to stop.\n");

	logInterval = setInterval(() => {
		const inflight = submitted - acked;
		console.log(`submitted=${submitted} acked=${acked} inflight=${inflight}`);
	}, 1000);
};

ws.onerror = (error) => {
	console.error("WebSocket error:", error);
	if (logInterval) clearInterval(logInterval);
};

ws.onclose = async () => {
	console.log("\nConnection closed, draining...");
	if (logInterval) clearInterval(logInterval);
	await producer.close();
	await stream.close();
	console.log(`Final: submitted=${submitted} acked=${acked}`);
};

ws.onmessage = async (event) => {
	try {
		const data: JetstreamEvent = JSON.parse(event.data as string);

		if (
			data.kind !== "commit" ||
			data.commit?.operation !== "create" ||
			data.commit?.collection !== "app.bsky.feed.post"
		) {
			return;
		}

		const post = data.commit.record;
		if (!post?.text) return;

		const ticket = await producer.submit(
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
		submitted++;

		ticket.ack().then(() => {
			acked++;
		});
	} catch (err) {
		console.error("Error processing message:", err);
	}
};

process.on("SIGINT", async () => {
	console.log("\nShutting down...");
	ws.close();
});
