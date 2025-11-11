import { createWriteStream } from "node:fs";
import {
	AppendRecord,
	BatchTransform,
	type ReadRecord,
	S2,
} from "../src/index.js";

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

// const s2 = new S2({
// 	accessToken: process.env.S2_ACCESS_TOKEN!,
// });

const s2 = new S2({
	accessToken: process.env.S2_ACCESS_TOKEN!,
	baseUrl: `https://${process.env.S2_ACCOUNT_ENDPOINT!}/v1`,
	makeBasinBaseUrl: (basinName) =>
		`https://${process.env.S2_ACCOUNT_ENDPOINT!}/v1`,
	retry: {
		maxAttempts: 10,
		retryBackoffDurationMs: 1000,
		appendRetryPolicy: "all",
	},
});

const basinName = process.env.S2_BASIN;
if (!basinName) {
	console.error("S2_BASIN environment variable is not set");
	process.exit(1);
}

const basin = s2.basin(process.env.S2_BASIN!);
const stream = basin.stream("image");

const startAt = await stream.checkTail();

const session = await stream.appendSession({
	maxQueuedBytes: 1024 * 1024 * 10,
});
let image = await fetch(
	"https://upload.wikimedia.org/wikipedia/commons/2/24/Peter_Paul_Rubens_-_Self-portrait_-_RH.S.180_-_Rubenshuis_%28after_restoration%29.jpg",
);

// Write directly from fetch response to S2 stream
let append = await image
	.body! // Ensure each chunk is at most 128KiB. S2 has a maximum individual record size of 1MiB.
	.pipeThrough(rechunkStream(1024 * 128))
	// Convert each chunk to an AppendRecord.
	.pipeThrough(
		new TransformStream<Uint8Array, AppendRecord>({
			transform(arr, controller) {
				controller.enqueue(AppendRecord.make(arr));
			},
		}),
	)
	// Collect records into batches.
	.pipeThrough(
		new BatchTransform({
			lingerDurationMillis: 1,
			match_seq_num: 0,
		}),
	)
	// Write to the S2 stream.
	.pipeTo(session.writable);

console.log(
	`image written to S2 over ${session.lastAckedPosition()!.end!.seq_num - startAt.tail.seq_num} records, starting at seqNum=${startAt.tail.seq_num}`,
);

let readSession = await stream.readSession({
	seq_num: startAt.tail.seq_num,
	count: session.lastAckedPosition()!.end!.seq_num - startAt.tail.seq_num,
	as: "bytes",
});

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
