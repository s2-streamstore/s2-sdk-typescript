import { createWriteStream } from "node:fs";

import {
	AppendRecord,
	BatchTransform,
	Producer,
	type ReadRecord,
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
	throw new Error("Set S2_BASIN so we know where to work.");
}

const streamName = process.env.S2_STREAM ?? "image/demo";

// Stream transformation for chunking large binary arrays into ones of no larger than `desiredChunkSize`.
function rechunkStream(
	desiredChunkSize: number,
): TransformStream<Uint8Array, Uint8Array> {
	let buffer = new Uint8Array(0);
	return new TransformStream({
		transform(chunk, controller) {
			const newBuffer = new Uint8Array(buffer.length + chunk.length);
			newBuffer.set(buffer);
			newBuffer.set(chunk, buffer.length);
			buffer = newBuffer;
			while (buffer.length >= desiredChunkSize) {
				controller.enqueue(buffer.slice(0, desiredChunkSize));
				buffer = buffer.slice(desiredChunkSize);
			}
		},
		flush(controller) {
			if (buffer.length > 0) {
				controller.enqueue(buffer);
			}
		},
	});
}

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
	retry: {
		maxAttempts: 3,
		minDelayMillis: 100,
		maxDelayMillis: 1000,
		appendRetryPolicy: "noSideEffects",
	},
});

const basin = s2.basin(basinName);

// Create the image stream if it doesn't already exist.
await basin.streams.create({ stream: streamName }).catch((error: unknown) => {
	if (error instanceof S2Error && error.status === 409) {
		console.log(`Stream ${streamName} already exists.`);
		return undefined;
	}
	throw error;
});

const stream = basin.stream(streamName);
const startAt = await stream.checkTail();

const producer = new Producer(
	new BatchTransform({
		lingerDurationMillis: 100,
		matchSeqNum: startAt.tail.seqNum,
	}),
	await stream.appendSession({
		maxInflightBytes: 5 * 1024 * 1024,
	}),
);

// Fetch an image stream from the web.
let image = await fetch(
	"https://upload.wikimedia.org/wikipedia/commons/2/24/Peter_Paul_Rubens_-_Self-portrait_-_RH.S.180_-_Rubenshuis_%28after_restoration%29.jpg",
);

// Write directly from fetch response to S2 stream
await image
	.body! // Ensure each chunk is at most 128KiB. S2 has a maximum individual record size of 1MiB.
	.pipeThrough(rechunkStream(1024 * 128))
	// Convert each chunk to an AppendRecord.
	.pipeThrough(
		new TransformStream<Uint8Array, AppendRecord>({
			transform(arr, controller) {
				controller.enqueue(AppendRecord.bytes({ body: arr }));
			},
		}),
	)
	// Write to the S2 stream.
	.pipeTo(producer.writable);

console.log(
	`image written to S2 over ${producer.appendSession.lastAckedPosition()!.end!.seqNum - startAt.tail.seqNum} records, starting at seq_num=${startAt.tail.seqNum}`,
);

let readSession = await stream.readSession(
	{
		start: { from: { seqNum: startAt.tail.seqNum } },
		stop: {
			limits: {
				count:
					producer.appendSession.lastAckedPosition()!.end.seqNum -
					startAt.tail.seqNum,
			},
		},
	},
	{ as: "bytes" },
);

// Write to a local file.
const id = Math.random().toString(36).slice(2, 10);
// Use a larger buffer (default is 16KB, we use 512KB)
const out = createWriteStream(`image-${id}.jpg`, {
	highWaterMark: 512 * 1024, // 512KB buffer
});

await readSession
	.pipeThrough(
		new TransformStream<ReadRecord<"bytes">, Uint8Array>({
			transform(arr, controller) {
				controller.enqueue(arr.body);
			},
		}),
	)
	.pipeTo(
		new WritableStream({
			async write(chunk) {
				// Handle backpressure - wait if buffer is full
				if (!out.write(chunk)) {
					await new Promise<void>((resolve) => out.once("drain", resolve));
				}
			},
			// Don't close here - we'll close manually after to ensure flush
		}),
	);

// Ensure the file is fully written and closed before exiting
await new Promise<void>((resolve, reject) => {
	out.close((err) => {
		if (err) reject(err);
		else resolve();
	});
});

console.log(`Image written to image-${id}.jpg`);

process.exit(0);
