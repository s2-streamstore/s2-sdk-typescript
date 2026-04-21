import {
	AppendInput,
	AppendRecord,
	S2,
	S2Environment,
} from "@s2-dev/streamstore";
import type { UIMessageChunk } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createResumableChat } from "../aisdk.js";

const TEST_TIMEOUT_MS = 120_000;

const hasEnv = !!process.env.S2_ACCESS_TOKEN;
const describeIf = hasEnv ? describe : describe.skip;

const makeBasinName = (): string => {
	const suffix = Math.random().toString(36).slice(2, 10);
	return `resumable-aisdk-${suffix}`.slice(0, 48);
};

const makeStreamName = (prefix: string): string =>
	`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
	throw new Error(`Timed out waiting for basin ${basin}`);
};

async function* arrayToAsyncIterable<T>(items: T[]): AsyncIterable<T> {
	for (const item of items) {
		yield item;
	}
}

async function* delayedAsyncIterable<T>(
	items: T[],
	delayMs = 25,
): AsyncIterable<T> {
	for (let index = 0; index < items.length; index += 1) {
		yield items[index]!;
		if (index < items.length - 1) {
			await sleep(delayMs);
		}
	}
}

async function readSseResponse(res: Response): Promise<unknown[]> {
	const text = await res.text();
	const results: unknown[] = [];
	for (const block of text.split("\n\n")) {
		const trimmed = block.trim();
		if (!trimmed.startsWith("data: ")) continue;
		const payload = trimmed.slice("data: ".length);
		if (payload === "[DONE]") continue;
		results.push(JSON.parse(payload));
	}
	return results;
}

function sampleChunks(text = "Hello world"): UIMessageChunk[] {
	const [head = "", ...rest] = text.split(" ");
	return [
		{ type: "start" },
		{ type: "text-start", id: "text-1" },
		{ type: "text-delta", id: "text-1", delta: head },
		...(rest.length > 0
			? [{ type: "text-delta", id: "text-1", delta: ` ${rest.join(" ")}` }]
			: []),
		{ type: "text-end", id: "text-1" },
		{ type: "finish", finishReason: "stop" },
	];
}

let s2: S2;
let basinName: string;

describeIf("resumable-stream/aisdk", () => {
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

	describe("makeResumable", () => {
		it(
			"streams the source back to the client as SSE",
			async () => {
				const chat = createResumableChat({
					accessToken: process.env.S2_ACCESS_TOKEN!,
					basin: basinName,
					...s2EndpointsFromEnv(),
				});
				const streamName = makeStreamName("resumable-basic");
				const chunks = sampleChunks();

				const res = await chat.makeResumable(
					streamName,
					arrayToAsyncIterable(chunks),
				);

				expect(res.status).toBe(200);
				expect(res.headers.get("Content-Type")).toBe("text/event-stream");
				expect(await readSseResponse(res)).toEqual(chunks);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"runs persistence under waitUntil while the client consumes the body",
			async () => {
				const chat = createResumableChat({
					accessToken: process.env.S2_ACCESS_TOKEN!,
					basin: basinName,
					...s2EndpointsFromEnv(),
				});
				const streamName = makeStreamName("resumable-bg");
				const chunks = sampleChunks();

				let bgPromise: Promise<unknown> | undefined;

				const res = await chat.makeResumable(
					streamName,
					arrayToAsyncIterable(chunks),
					{
						waitUntil: (promise) => {
							bgPromise = promise;
						},
					},
				);

				expect(res.status).toBe(200);
				expect(await readSseResponse(res)).toEqual(chunks);
				expect(bgPromise).toBeDefined();
				await bgPromise;

				// After waitUntil resolves, a replay of a completed single-use
				// stream must return 204.
				const replay = await chat.replay(streamName);
				expect(replay.status).toBe(204);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"appends a trim after a single-use generation for self-cleanup",
			async () => {
				const chat = createResumableChat({
					accessToken: process.env.S2_ACCESS_TOKEN!,
					basin: basinName,
					...s2EndpointsFromEnv(),
				});
				const streamName = makeStreamName("single-use-trim");
				const chunks = sampleChunks();

				let bgPromise: Promise<unknown> | undefined;
				const res = await chat.makeResumable(
					streamName,
					arrayToAsyncIterable(chunks),
					{
						waitUntil: (promise) => {
							bgPromise = promise;
						},
					},
				);
				expect(res.status).toBe(200);
				await res.text();
				await bgPromise;

				// Opening fence + N data chunks + terminal fence + trim.
				// The trim itself may already be trimmed by the time we read,
				// but `tail.seqNum` is preserved even for trimmed records, so
				// we assert on the tail position rather than record presence.
				const expectedAppendCount = 1 + chunks.length + 1 + 1;
				const raw = await s2
					.basin(basinName)
					.stream(streamName)
					.read(
						{
							start: { from: { seqNum: 0 }, clamp: true },
							stop: { limits: { count: 50 } },
						},
						{ as: "string" },
					);
				expect(raw.tail?.seqNum).toBe(expectedAppendCount);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns 409 when a single-use stream is already claimed",
			async () => {
				const chat = createResumableChat({
					accessToken: process.env.S2_ACCESS_TOKEN!,
					basin: basinName,
					...s2EndpointsFromEnv(),
				});
				const streamName = makeStreamName("resumable-conflict");

				const res1 = await chat.makeResumable(
					streamName,
					arrayToAsyncIterable(sampleChunks()),
				);
				expect(res1.status).toBe(200);
				await res1.text();

				const res2 = await chat.makeResumable(
					streamName,
					arrayToAsyncIterable(sampleChunks()),
				);
				expect(res2.status).toBe(409);
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("replay", () => {
		it(
			"tails the active generation from S2 while the client drops the POST body",
			async () => {
				const chat = createResumableChat({
					accessToken: process.env.S2_ACCESS_TOKEN!,
					basin: basinName,
					...s2EndpointsFromEnv(),
				});
				const streamName = makeStreamName("replay-bg");
				const chunks = sampleChunks();

				let bgPromise: Promise<unknown> | undefined;
				const postRes = await chat.makeResumable(
					streamName,
					delayedAsyncIterable(chunks),
					{
						waitUntil: (promise) => {
							bgPromise = promise;
						},
					},
				);

				// Simulate the client disconnecting before consuming any chunks.
				// Tee semantics: persist branch continues independently.
				await postRes.body?.cancel();

				const replayRes = await chat.replay(streamName);
				expect(replayRes.status).toBe(200);
				expect(replayRes.headers.get("Content-Type")).toBe("text/event-stream");

				const records = await readSseResponse(replayRes);
				expect(records).toEqual(chunks);

				await bgPromise;
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("shared streams", () => {
		it(
			"reuses a completed stream and replays the active generation",
			async () => {
				const chat = createResumableChat({
					accessToken: process.env.S2_ACCESS_TOKEN!,
					basin: basinName,
					streamReuse: "shared",
					...s2EndpointsFromEnv(),
				});
				const streamName = makeStreamName("shared-reuse");
				const firstChunks = sampleChunks("Hello world");
				const secondChunks = sampleChunks("Second pass");

				let firstBg: Promise<unknown> | undefined;
				const res1 = await chat.makeResumable(
					streamName,
					arrayToAsyncIterable(firstChunks),
					{
						waitUntil: (promise) => {
							firstBg = promise;
						},
					},
				);
				expect(res1.status).toBe(200);
				await res1.text();
				await firstBg;

				let secondBg: Promise<unknown> | undefined;
				const res2 = await chat.makeResumable(
					streamName,
					delayedAsyncIterable(secondChunks),
					{
						waitUntil: (promise) => {
							secondBg = promise;
						},
					},
				);
				expect(res2.status).toBe(200);
				await res2.body?.cancel();

				const latest = await chat.replay(streamName);
				expect(latest.status).toBe(200);
				expect(await readSseResponse(latest)).toEqual(secondChunks);

				await secondBg;

				const raw = await s2
					.basin(basinName)
					.stream(streamName)
					.read(
						{
							start: { from: { seqNum: 0 }, clamp: true },
							stop: { limits: { count: 50 } },
						},
						{ as: "string" },
					);
				expect(
					raw.records.some(
						(record) =>
							record.headers.length === 1 &&
							record.headers[0]?.[0] === "" &&
							record.headers[0]?.[1] === "trim",
					),
				).toBe(true);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns 409 when a non-terminal fence is still within its lease",
			async () => {
				const chat = createResumableChat({
					accessToken: process.env.S2_ACCESS_TOKEN!,
					basin: basinName,
					streamReuse: "shared",
					leaseDurationMs: 60_000,
					...s2EndpointsFromEnv(),
				});
				const streamName = makeStreamName("shared-held");

				// Simulate an in-flight generation: fence now, no terminal.
				await s2
					.basin(basinName)
					.stream(streamName)
					.append(
						AppendInput.create([AppendRecord.fence("holder-abcd", Date.now())]),
					);

				const blocked = await chat.makeResumable(
					streamName,
					arrayToAsyncIterable(sampleChunks()),
				);
				expect(blocked.status).toBe(409);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"takes over a shared stream whose lease has expired",
			async () => {
				const leaseDurationMs = 60_000;
				const chat = createResumableChat({
					accessToken: process.env.S2_ACCESS_TOKEN!,
					basin: basinName,
					streamReuse: "shared",
					leaseDurationMs,
					...s2EndpointsFromEnv(),
				});
				const streamName = makeStreamName("shared-expired");

				// Simulate a crashed generation: fence with a timestamp well in
				// the past, no terminal fence, no data. s2 preserves past
				// client timestamps under the default ClientPrefer mode.
				const staleTimestamp = Date.now() - leaseDurationMs - 10_000;
				await s2
					.basin(basinName)
					.stream(streamName)
					.append(
						AppendInput.create([
							AppendRecord.fence("stale-holder", staleTimestamp),
						]),
					);

				const chunks = sampleChunks("Took over");
				const res = await chat.makeResumable(
					streamName,
					arrayToAsyncIterable(chunks),
				);
				expect(res.status).toBe(200);
				expect(await readSseResponse(res)).toEqual(chunks);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns 204 once a shared stream is idle",
			async () => {
				const chat = createResumableChat({
					accessToken: process.env.S2_ACCESS_TOKEN!,
					basin: basinName,
					streamReuse: "shared",
					...s2EndpointsFromEnv(),
				});
				const streamName = makeStreamName("shared-idle");

				let bgPromise: Promise<unknown> | undefined;
				const res = await chat.makeResumable(
					streamName,
					arrayToAsyncIterable(sampleChunks("Idle latest")),
					{
						waitUntil: (promise) => {
							bgPromise = promise;
						},
					},
				);
				expect(res.status).toBe(200);
				await res.text();
				await bgPromise;

				const replay = await chat.replay(streamName);
				expect(replay.status).toBe(204);
			},
			TEST_TIMEOUT_MS,
		);
	});
});

function s2EndpointsFromEnv(): {
	endpoints?: { account?: string; basin?: string };
} {
	const account = process.env.S2_ACCOUNT_ENDPOINT || undefined;
	const basin = process.env.S2_BASIN_ENDPOINT || undefined;
	if (account || basin) return { endpoints: { account, basin } };
	return {};
}
