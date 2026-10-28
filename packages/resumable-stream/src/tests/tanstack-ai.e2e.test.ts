import {
	AppendInput,
	AppendRecord,
	FencingTokenMismatchError,
	S2,
	S2Environment,
	S2Stream,
} from "@s2-dev/streamstore";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Chunk, createResumableChat } from "../tanstack-ai/index.js";

const describeIf = process.env.S2_ACCESS_TOKEN ? describe : describe.skip;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function within<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("timed out after 5000ms")),
					5000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function readChunks(response: Response): Promise<Chunk[]> {
	return (await response.text())
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => JSON.parse(line.slice(6)) as Chunk);
}

describeIf("resumable-stream/tanstack-ai stop", () => {
	let s2: S2;
	const basin = `resumable-tanstack-${Math.random().toString(36).slice(2, 10)}`;
	const config = () => ({
		...S2Environment.parse(),
		accessToken: process.env.S2_ACCESS_TOKEN!,
		basin,
		mode: "session" as const,
		batchSize: 1,
	});

	beforeAll(async () => {
		s2 = new S2(config());
		await s2.basins.create({
			basin,
			config: { createStreamOnAppend: true, createStreamOnRead: true },
		});
		await vi.waitFor(() => s2.basins.getConfig({ basin }), {
			timeout: 60_000,
			interval: 500,
		});
	}, 65_000);

	afterAll(async () => {
		await s2?.basins.delete({ basin });
	});

	it.each(["normal", "interrupted"] as const)(
		"PR #398: stops an active writer across adapters and preserves its boundary (%s)",
		async (completion) => {
			const streamName = `stop-${completion}-${Date.now()}`;
			const handle = s2.basin(basin).stream(streamName);
			const cleanup = new AbortController();
			const append = S2Stream.prototype.append;
			let interrupted = false;
			const appendSpy = vi
				.spyOn(S2Stream.prototype, "append")
				.mockImplementation(function (input, options) {
					if (
						completion === "interrupted" &&
						!interrupted &&
						input.fencingToken?.startsWith("stop-")
					) {
						interrupted = true;
						return Promise.reject(new Error("stop finalization interrupted"));
					}
					return append.call(this, input, options);
				});
			let writerEnded = false;
			let background: Promise<unknown> = Promise.resolve();
			const responses: Response[] = [];
			try {
				const writer = createResumableChat(config());
				const response = await writer.makeResumable(
					streamName,
					async function* (signal) {
						try {
							yield { type: "RUN_STARTED", runId: "run-a", threadId: "thread" };
							yield {
								type: "TEXT_MESSAGE_START",
								messageId: "message-a",
								role: "assistant",
							};
							while (!signal.aborted && !cleanup.signal.aborted) {
								yield {
									type: "TEXT_MESSAGE_CONTENT",
									messageId: "message-a",
									delta: "a",
								};
								await sleep(1);
							}
						} finally {
							writerEnded = true;
						}
					},
					{
						waitUntil: (promise) => {
							background = promise;
						},
					},
				);
				responses.push(response);
				await expect
					.poll(async () => (await handle.checkTail()).tail.seqNum, {
						timeout: 5000,
					})
					.toBeGreaterThan(3);
				const opening = await handle.read(
					{
						start: { from: { seqNum: 0 } },
						stop: { limits: { count: 1 }, waitSecs: 0 },
					},
					{ as: "string" },
				);
				const stop = () => createResumableChat(config()).stop(streamName);
				if (completion === "interrupted") {
					await expect(within(stop())).rejects.toThrow(
						"stop finalization interrupted",
					);
				}
				const replay = await createResumableChat(config()).replay(streamName);
				responses.push(replay);
				expect(await within(stop())).toBe(true);
				await within(background);
				expect(writerEnded).toBe(true);
				await expect(
					handle.append(
						AppendInput.create([AppendRecord.string({ body: "late" })], {
							fencingToken: opening.records[0]!.body,
						}),
					),
				).rejects.toBeInstanceOf(FencingTokenMismatchError);

				const next = await writer.makeResumable(
					streamName,
					(async function* () {
						yield { type: "RUN_STARTED", runId: "run-b", threadId: "thread" };
						yield {
							type: "RUN_FINISHED",
							runId: "run-b",
							threadId: "thread",
							finishReason: "stop",
						};
					})(),
				);
				responses.push(next);
				const [sent, replayed, nextRun] = await within(
					Promise.all([
						readChunks(response),
						readChunks(replay),
						readChunks(next),
					]),
				);
				expect(replayed).toEqual(sent);
				expect(sent.filter((chunk) => chunk.type === "RUN_FINISHED")).toEqual([
					expect.objectContaining({
						runId: "run-a",
						threadId: "thread",
						finishReason: "stop",
					}),
				]);
				expect(sent.some((chunk) => chunk.runId === "run-b")).toBe(false);
				expect(nextRun.at(-1)?.runId).toBe("run-b");
			} finally {
				appendSpy.mockRestore();
				cleanup.abort();
				await within(background).catch(() => {});
				await Promise.all(
					responses.map((response) => response.body?.cancel().catch(() => {})),
				);
				await handle.close();
			}
		},
		20_000,
	);
});
