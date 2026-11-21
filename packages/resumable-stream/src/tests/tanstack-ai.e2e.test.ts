import { S2, S2Environment, S2Stream } from "@s2-dev/streamstore";
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

	it("PR #398: an interrupted stop can finish an active writer from a fresh adapter", async () => {
		const streamName = `stop-interrupted-${Date.now()}`;
		const handle = s2.basin(basin).stream(streamName);
		const cleanup = new AbortController();
		const append = S2Stream.prototype.append;
		let interrupted = false;
		const appendSpy = vi
			.spyOn(S2Stream.prototype, "append")
			.mockImplementation(function (input, options) {
				if (!interrupted && input.fencingToken?.startsWith("stop-")) {
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
			const stop = () => createResumableChat(config()).stop(streamName);
			await expect(within(stop())).rejects.toThrow(
				"stop finalization interrupted",
			);
			const replay = await createResumableChat(config()).replay(streamName);
			responses.push(replay);
			expect(await within(stop())).toBe(true);
			await within(background);
			expect(writerEnded).toBe(true);
			const [sent, replayed] = await within(
				Promise.all([readChunks(response), readChunks(replay)]),
			);
			expect(replayed).toEqual(sent);
			expect(sent.filter((chunk) => chunk.type === "RUN_FINISHED")).toEqual([
				expect.objectContaining({
					runId: "run-a",
					threadId: "thread",
					finishReason: "stop",
				}),
			]);
		} finally {
			appendSpy.mockRestore();
			cleanup.abort();
			await within(background).catch(() => {});
			await Promise.all(
				responses.map((response) =>
					within(response.body?.cancel() ?? Promise.resolve()).catch(() => {}),
				),
			);
			await handle.close();
		}
	}, 20_000);
});
