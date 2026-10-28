import {
	type ReadRecord,
	type ReadSession,
	S2,
	S2Environment,
	S2Stream,
} from "@s2-dev/streamstore";
import type { UIMessageChunk } from "ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createChat } from "../adapter.js";
import { createResumableChat } from "../aisdk/index.js";

const describeIf = process.env.S2_ACCESS_TOKEN ? describe : describe.skip;

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function within<T>(promise: Promise<T>, timeout = 5000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`operation stayed idle for ${timeout}ms`)),
					timeout,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

describeIf("resumable-stream cancellation", () => {
	let s2: S2;
	const basin = `resumable-cancel-${Math.random().toString(36).slice(2, 10)}`;
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
		await vi.waitFor(() => s2.basins.getConfig({ basin }), { timeout: 60_000 });
	}, 65_000);

	afterAll(async () => {
		await s2?.basins.delete({ basin });
	});

	it.each(["response", "live replay"] as const)(
		"PR #398: disconnecting an idle %s closes its reader while persistence continues",
		async (delivery) => {
			const streamName = `cancel-${delivery}-${Date.now()}`;
			const releaseSource = deferred();
			const idleRead = deferred();
			const readSession = S2Stream.prototype.readSession;
			let readerHandle: S2Stream | undefined;
			let disposed = false;
			const readSpy = vi
				.spyOn(S2Stream.prototype, "readSession")
				.mockImplementation(async function (input, options) {
					const session = await readSession.call(this, input, options);
					if (input?.stop?.waitSecs === 0) return session;
					readerHandle = this;
					let lastSeqNum = -1;
					return {
						[Symbol.asyncIterator]() {
							const iterator = session[Symbol.asyncIterator]();
							return {
								async next() {
									if (lastSeqNum === 1) idleRead.resolve();
									const next = await iterator.next();
									if (!next.done) lastSeqNum = next.value.seqNum;
									return next;
								},
								return: () => iterator.return!(),
							};
						},
						getReader() {
							const reader = session.getReader();
							return {
								closed: reader.closed,
								async read() {
									// Seq 0 is the claim, seq 1 the only chunk until releaseSource.
									if (lastSeqNum === 1) idleRead.resolve();
									const next = await reader.read();
									if (!next.done) lastSeqNum = next.value.seqNum;
									return next;
								},
								cancel: (reason?: unknown) => reader.cancel(reason),
								releaseLock: () => reader.releaseLock(),
							};
						},
						async [Symbol.asyncDispose]() {
							await session[Symbol.asyncDispose]();
							disposed = true;
						},
					} as ReadSession;
				});
			const closeSpy = vi.spyOn(S2Stream.prototype, "close");
			let background: Promise<unknown> = Promise.resolve();
			let sourceSignal: AbortSignal | undefined;
			let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
			try {
				const chat = createResumableChat(config());
				const started = await chat.makeResumable(
					streamName,
					async function* (signal): AsyncIterable<UIMessageChunk> {
						sourceSignal = signal;
						yield { type: "start" };
						await releaseSource.promise;
						yield { type: "finish", finishReason: "stop" };
					},
					{
						delivery: delivery === "response" ? "response" : "replay",
						waitUntil: (promise) => {
							background = promise;
						},
					},
				);
				const response =
					delivery === "response"
						? started
						: await chat.replay(streamName, { live: true });
				reader = response.body!.getReader();
				expect((await within(reader.read())).done).toBe(false);
				const pendingRead = reader.read();
				await within(idleRead.promise);
				await within(reader.cancel(), 1000);
				expect(await pendingRead).toEqual({ done: true, value: undefined });
				expect(disposed).toBe(true);
				expect(closeSpy.mock.contexts).toContain(readerHandle);
				expect(sourceSignal?.aborted).toBe(false);

				releaseSource.resolve();
				await within(background);
				const handle = s2.basin(basin).stream(streamName);
				try {
					const { records } = await handle.read(
						{ start: { from: { seqNum: 0 } }, stop: { waitSecs: 0 } },
						{ as: "string" },
					);
					expect(
						records
							.filter((record: ReadRecord) => record.headers.length === 0)
							.map((record) => JSON.parse(record.body)),
					).toEqual([
						{ type: "start" },
						{ type: "finish", finishReason: "stop" },
					]);
				} finally {
					await handle.close();
				}
			} finally {
				releaseSource.resolve();
				await within(background).catch(() => {});
				await within(reader?.cancel() ?? Promise.resolve()).catch(() => {});
				readSpy.mockRestore();
				closeSpy.mockRestore();
			}
		},
		10_000,
	);
});

it("PR #398: cancellation closes a reader before its transport finishes opening", async () => {
	const opening = deferred();
	const reading = deferred();
	const cancel = vi.fn();
	const session = new ReadableStream<ReadRecord<"string">>({
		async start() {
			await opening.promise;
		},
		cancel,
	});
	const iterate = session[Symbol.asyncIterator].bind(session);
	vi.spyOn(session, Symbol.asyncIterator).mockImplementation(() => {
		reading.resolve();
		return iterate();
	});
	const getReader = session.getReader.bind(session);
	vi.spyOn(session, "getReader").mockImplementation(() => {
		const reader = getReader();
		const read = reader.read.bind(reader);
		vi.spyOn(reader, "read").mockImplementation(() => {
			reading.resolve();
			return read();
		});
		return reader;
	});
	const handle = { readSession: async () => session, close: vi.fn() };
	const chat = createChat(
		{ accessToken: "t", basin: "b", mode: "session" },
		{ makeErrorChunk: () => ({}), responseHeaders: {} },
		{ basin: () => ({ stream: () => handle }) } as unknown as S2,
	);
	try {
		const response = await chat.replay("s", { live: true });
		const reader = response.body!.getReader();
		const pendingRead = reader.read();
		await within(reading.promise);
		await within(reader.cancel(), 1000);
		expect(await pendingRead).toEqual({ done: true, value: undefined });
		expect(cancel).toHaveBeenCalledOnce();
		expect(handle.close).toHaveBeenCalled();
		expect(session.locked).toBe(false);
	} finally {
		opening.resolve();
	}
}, 10_000);
