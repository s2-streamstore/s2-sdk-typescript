import { S2, S2Environment } from "@s2-dev/streamstore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDurableChat } from "../server.js";

const TEST_TIMEOUT_MS = 120_000;

const hasEnv = !!process.env.S2_ACCESS_TOKEN;
const describeIf = hasEnv ? describe : describe.skip;

const makeBasinName = (): string => {
	const suffix = Math.random().toString(36).slice(2, 10);
	return `durability-${suffix}`.slice(0, 48);
};

const makeStreamName = (prefix: string): string =>
	`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const sleep = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));

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
	throw new Error(`Timed out waiting for basin ${basin}`);
};

async function* arrayToAsyncIterable<T>(items: T[]): AsyncIterable<T> {
	for (const item of items) {
		yield item;
	}
}

async function readNdjsonResponse(res: Response): Promise<unknown[]> {
	const text = await res.text();
	return text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

let s2: S2;
let basinName: string;

describeIf("durable-aisdk", () => {
	beforeAll(async () => {
		const env = S2Environment.parse();
		s2 = new S2(env as { accessToken: string });
		basinName = makeBasinName();
		try {
			await s2.basins.create({
				basin: basinName,
				config: { createStreamOnAppend: true, createStreamOnRead: true },
			});
		} catch (err: unknown) {
			if (
				err &&
				typeof err === "object" &&
				"status" in err &&
				(err as { status: number }).status === 422 &&
				String(err).includes("free tier")
			)
				return;
			throw err;
		}
		await waitForBasinReady(s2, basinName);
	}, TEST_TIMEOUT_MS);

	afterAll(async () => {
		if (!s2 || !basinName) return;
		try {
			await s2.basins.delete({ basin: basinName });
		} catch {
			// best-effort
		}
	}, TEST_TIMEOUT_MS);

	describe("persist", () => {
		it(
			"writes chunks and returns { stream } response",
			async () => {
				const chat = createDurableChat({
					accessToken: process.env.S2_ACCESS_TOKEN!,
					basin: basinName,
					...s2EndpointsFromEnv(),
				});
				const streamName = makeStreamName("persist-basic");
				const chunks = [
					{ type: "text-delta", text: "Hello" },
					{ type: "text-delta", text: " world" },
					{ type: "finish", finishReason: "stop" },
				];

				const res = await chat.persist(
					streamName,
					arrayToAsyncIterable(chunks),
				);

				expect(res.status).toBe(200);
				const body = (await res.json()) as { stream: string };
				expect(body.stream).toBe(streamName);
				expect(res.headers.get("Cache-Control")).toBe("no-store");
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns 200 immediately with waitUntil and completes in background",
			async () => {
				const chat = createDurableChat({
					accessToken: process.env.S2_ACCESS_TOKEN!,
					basin: basinName,
					...s2EndpointsFromEnv(),
				});
				const streamName = makeStreamName("persist-bg");

				let bgPromise: Promise<unknown> | undefined;

				const chunks = [
					{ type: "text-delta", text: "bg" },
					{ type: "finish", finishReason: "stop" },
				];

				const res = await chat.persist(
					streamName,
					arrayToAsyncIterable(chunks),
					{
						waitUntil: (p) => {
							bgPromise = p;
						},
					},
				);

				expect(res.status).toBe(200);
				const body = (await res.json()) as { stream: string };
				expect(body.stream).toBe(streamName);

				// The background write should eventually complete
				expect(bgPromise).toBeDefined();
				await bgPromise;
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns 409 when stream is already claimed",
			async () => {
				const chat = createDurableChat({
					accessToken: process.env.S2_ACCESS_TOKEN!,
					basin: basinName,
					...s2EndpointsFromEnv(),
				});
				const streamName = makeStreamName("persist-conflict");

				// First persist claims the stream
				const res1 = await chat.persist(
					streamName,
					arrayToAsyncIterable([{ type: "text-delta", text: "first" }]),
				);
				expect(res1.status).toBe(200);

				// Second persist on the same stream should get 409
				const res2 = await chat.persist(
					streamName,
					arrayToAsyncIterable([{ type: "text-delta", text: "second" }]),
				);
				expect(res2.status).toBe(409);
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("replay", () => {
		it(
			"returns persisted chunks as NDJSON",
			async () => {
				const chat = createDurableChat({
					accessToken: process.env.S2_ACCESS_TOKEN!,
					basin: basinName,
					...s2EndpointsFromEnv(),
				});
				const streamName = makeStreamName("replay-basic");
				const chunks = [
					{ type: "text-delta", text: "Hello" },
					{ type: "text-delta", text: " world" },
					{ type: "finish", finishReason: "stop" },
				];

				await chat.persist(streamName, arrayToAsyncIterable(chunks));

				const res = await chat.replay(streamName);
				expect(res.status).toBe(200);
				expect(res.headers.get("Content-Type")).toBe(
					"application/x-ndjson",
				);

				const records = await readNdjsonResponse(res);
				expect(records).toEqual(chunks);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"skips fence records in output",
			async () => {
				const chat = createDurableChat({
					accessToken: process.env.S2_ACCESS_TOKEN!,
					basin: basinName,
					...s2EndpointsFromEnv(),
				});
				const streamName = makeStreamName("replay-fences");
				const chunks = [{ type: "text-delta", text: "only-this" }];

				await chat.persist(streamName, arrayToAsyncIterable(chunks));

				const records = await readNdjsonResponse(
					await chat.replay(streamName),
				);

				// Should only contain data records, no fence commands
				for (const rec of records) {
					expect(rec).toHaveProperty("type");
				}
				expect(records).toEqual(chunks);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"works with waitUntil persist followed by replay",
			async () => {
				const chat = createDurableChat({
					accessToken: process.env.S2_ACCESS_TOKEN!,
					basin: basinName,
					...s2EndpointsFromEnv(),
				});
				const streamName = makeStreamName("replay-bg");
				const chunks = [
					{ type: "text-delta", text: "async" },
					{ type: "finish", finishReason: "stop" },
				];

				let bgPromise: Promise<unknown> | undefined;
				await chat.persist(
					streamName,
					arrayToAsyncIterable(chunks),
					{ waitUntil: (p) => { bgPromise = p; } },
				);

				// Wait for background write to finish before replaying
				await bgPromise;

				const records = await readNdjsonResponse(
					await chat.replay(streamName),
				);
				expect(records).toEqual(chunks);
			},
			TEST_TIMEOUT_MS,
		);
	});
});

function s2EndpointsFromEnv(): { endpoints?: { account?: string; basin?: string } } {
	const account = process.env.S2_ACCOUNT_ENDPOINT || undefined;
	const basin = process.env.S2_BASIN_ENDPOINT || undefined;
	if (account || basin) return { endpoints: { account, basin } };
	return {};
}
