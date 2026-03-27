import { expect, test } from "vitest";
import { createResumableStreamContext } from "../index.js";

function createStreamFromArray(data: string[]): ReadableStream<string> {
	let index = 0;
	return new ReadableStream({
		pull(controller) {
			if (index < data.length) {
				controller.enqueue(data[index++]);
			} else {
				controller.close();
			}
		},
	});
}

async function readStreamToArray(
	stream: ReadableStream<string> | null,
	timeoutMs: number = 5000,
): Promise<string[]> {
	if (!stream) {
		return [];
	}
	const reader = stream.getReader();
	const result: string[] = [];

	const timeoutPromise = new Promise<never>((_, reject) => {
		setTimeout(() => reject(new Error("Stream read timeout")), timeoutMs);
	});

	try {
		while (true) {
			const readPromise = reader.read();
			const { done, value } = await Promise.race([readPromise, timeoutPromise]);

			if (done) break;
			if (value !== null && value !== undefined) {
				result.push(value);
			}
		}
	} finally {
		reader.releaseLock();
	}

	return result;
}

test("pub/sub", async () => {
	const context = createResumableStreamContext({
		waitUntil: async (promise) => {
			await promise;
		},
	});

	const originalData = ["msg1", "msg2", "msg3", "msg4", "msg5"];
	const streamId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

	const inputStream = createStreamFromArray(originalData);
	const publisherStream = await context.resumableStream(
		streamId,
		() => inputStream,
	);

	const publisherData = await readStreamToArray(publisherStream!);

	const resumedStream = await context.resumeStream(streamId);
	const subscriberData = await readStreamToArray(resumedStream);

	expect(publisherData).toEqual(originalData);
	expect(subscriberData).toEqual(originalData);
}, 30_000);

test("concurrent creators result in a single stream with consistent ordered data", async () => {
	const context = createResumableStreamContext({
		waitUntil: async (promise) => {
			await promise;
		},
	});

	const streamId = `concurrent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const initialMessages = ["msg1", "msg2", "msg3", "msg4"];

	const inputStream1 = createStreamFromArray([...initialMessages]);
	const inputStream2 = createStreamFromArray([...initialMessages]);
	const inputStream3 = createStreamFromArray([...initialMessages]);

	const writers = [
		context.resumableStream(streamId, () => inputStream1),
		context.resumableStream(streamId, () => inputStream2),
		context.resumableStream(streamId, () => inputStream3),
	];

	const results = await Promise.allSettled(writers);

	console.log("Results:", results);

	const successful = results.filter(
		(result) => result.status === "fulfilled" && result.value !== null,
	);
	expect(successful.length).toBeGreaterThanOrEqual(1);

	const resumedStream = await context.resumeStream(streamId);
	const finalStreamData = await readStreamToArray(resumedStream, 20000);

	expect(finalStreamData).toEqual(initialMessages);
}, 30_000);

test("concurrent readers", async () => {
	const context = createResumableStreamContext({
		waitUntil: async (promise) => {
			await promise;
		},
	});

	const streamId = `concurrent-reader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const messages = ["msg1", "msg2", "msg3", "msg4"];

	const inputStream = createStreamFromArray(messages);

	context.resumableStream(streamId, () => inputStream);

	const resumedStream1 = await context.resumeStream(streamId);
	const resumedStream2 = await context.resumeStream(streamId);
	const resumedStream3 = await context.resumeStream(streamId);

	const results = await Promise.allSettled([
		readStreamToArray(resumedStream1, 30000),
		readStreamToArray(resumedStream2, 30000),
		readStreamToArray(resumedStream3, 30000),
	]);

	console.log("Concurrent reader results:", results);
	const successful = results.filter((result) => result.status === "fulfilled");
	expect(successful.length).toBe(3);

	const readerData = results.map((result) =>
		result.status === "fulfilled" ? result.value : [],
	);

	expect(readerData[0]).toEqual(messages);
	expect(readerData[1]).toEqual(messages);
	expect(readerData[2]).toEqual(messages);
}, 30_000);
