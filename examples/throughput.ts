import { createWriteStream } from "node:fs";
import {
	AppendRecord,
	BatchTransform,
	type ReadRecord,
	S2,
} from "../src/index.js";

function createStringStream(
	n: number,
	delayMs: number = 0,
): ReadableStream<string> {
	let count = 0;
	return new ReadableStream<string>({
		async pull(controller) {
			if (count < n) {
				if (delayMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, delayMs));
				}
				console.log("pull", count);
				const randomChars = Array.from({ length: 1024 * 10 }, () =>
					String.fromCharCode(97 + Math.floor(Math.random() * 26)),
				).join("");

				var str = `${count} ${randomChars}`;
				controller.enqueue(str);
				count++;
			} else {
				controller.close();
			}
		},
	});
}

const s2 = new S2({
	accessToken: process.env.S2_ACCESS_TOKEN!,
	retry: {
		maxAttempts: 10,
		retryBackoffDurationMs: 100,
		appendRetryPolicy: "noSideEffects",
		requestTimeoutMillis: 10000,
	},
});

const basinName = process.env.S2_BASIN;
if (!basinName) {
	console.error("S2_BASIN environment variable is not set");
	process.exit(1);
}

const basin = s2.basin(basinName!);
const stream = basin.stream("throughput");

const sesh = await stream.appendSession({ maxQueuedBytes: 1024 * 1024 * 5 });

createStringStream(1000000, 0)
	.pipeThrough(
		new TransformStream<string, AppendRecord>({
			transform(arr, controller) {
				controller.enqueue(AppendRecord.make(arr));
			},
		}),
	)
	.pipeThrough(
		new BatchTransform({
			lingerDurationMillis: 100,
		}),
	)
	.pipeTo(sesh.writable);
