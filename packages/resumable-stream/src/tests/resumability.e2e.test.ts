import { afterAll, beforeAll, expect, test } from "vitest";
import { S2, S2Environment } from "@s2-dev/streamstore";
import { createResumableStreamContext } from "../index.js";

const makeBasinName = (): string => {
	const suffix = Math.random().toString(36).slice(2, 10);
	return `resumable-${suffix}`.slice(0, 48);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForBasinReady = async (s2: S2, basin: string): Promise<void> => {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			await s2.basins.getConfig({ basin });
			return;
		} catch (err) {
			const status =
				err && typeof err === "object" && "status" in err
					? (err as { status?: number }).status
					: undefined;
			if (status === 503) {
				await sleep(500);
				continue;
			}
			throw err;
		}
	}
	throw new Error(`Timed out waiting for basin ${basin} to become active`);
};

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

let s2: S2;
let basinName: string;

beforeAll(async () => {
	const env = S2Environment.parse();
	if (!env.accessToken) return;
	s2 = new S2(env as { accessToken: string });
	basinName = makeBasinName();
	await s2.basins.create({
		basin: basinName,
		config: { createStreamOnAppend: true, createStreamOnRead: true },
	});
	await waitForBasinReady(s2, basinName);
	process.env.S2_BASIN = basinName;
	process.env.S2_LINGER_DURATION = "100";
}, 120_000);

afterAll(async () => {
	if (!s2 || !basinName) return;
	try {
		await s2.basins.delete({ basin: basinName });
	} catch {
		// best-effort cleanup
	}
	delete process.env.S2_BASIN;
	delete process.env.S2_LINGER_DURATION;
});

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
