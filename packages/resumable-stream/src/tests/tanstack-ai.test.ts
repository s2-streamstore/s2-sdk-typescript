import type {
	AppendAck,
	AppendRecord as AppendRecordType,
	ReadRecord,
} from "@s2-dev/streamstore";
import {
	AppendInput,
	AppendRecord,
	FencingTokenMismatchError,
} from "@s2-dev/streamstore";
import { ChatClient } from "@tanstack/ai-client";
import { describe, expect, it, vi } from "vitest";
import { createConnection } from "../tanstack-ai/client.js";

interface SubmitTicket {
	ack(): Promise<AppendAck>;
	bytes: number;
	numRecords: number;
}

function makeAck(start: number, end: number): AppendAck {
	return {
		start: { seqNum: start, timestamp: new Date(0) },
		end: { seqNum: end, timestamp: new Date(0) },
		tail: { seqNum: end, timestamp: new Date(0) },
	};
}

class FakeAppendSession {
	readonly records: AppendRecordType[] = [];
	readonly readRecords: ReadRecord<"string">[] = [];
	closeCount = 0;
	private seqNum = 0;

	setNextSeqNum(seqNum: number): void {
		this.seqNum = seqNum;
	}

	async submit(input: AppendInput): Promise<SubmitTicket> {
		this.records.push(...input.records);
		const ack = makeAck(this.seqNum, this.seqNum + input.records.length);
		this.readRecords.push(
			...input.records.map((record, index) =>
				appendRecordToReadRecord(ack.start.seqNum + index, record),
			),
		);
		this.seqNum = ack.end.seqNum;
		return {
			ack: async () => ack,
			bytes: 0,
			numRecords: input.records.length,
		};
	}

	async close(): Promise<void> {
		this.closeCount += 1;
	}
}

interface FakeStreamOptions {
	failFenceClaim?: boolean;
	readRecords?: ReadRecord<"string">[];
	readRecordsAfterClaim?: ReadRecord<"string">[];
}

class FakeStream {
	readonly session = new FakeAppendSession();
	readonly directAppends: AppendInput[] = [];
	readonly directReadRecords: ReadRecord<"string">[] = [];
	closeCount = 0;
	private nextSeqOnAppend: number;
	readSessionCount = 0;

	constructor(private readonly options: FakeStreamOptions = {}) {
		this.nextSeqOnAppend = options.readRecords?.length ?? 0;
	}

	async appendSession() {
		this.session.setNextSeqNum(this.nextSeqOnAppend);
		return this.session;
	}

	async append(input: AppendInput): Promise<AppendAck> {
		if (this.options.failFenceClaim) {
			const { SeqNumMismatchError } = await import("@s2-dev/streamstore");
			throw new SeqNumMismatchError({
				message: "stream already in use",
				status: 412,
				expectedSeqNum: 1,
			});
		}
		const fencingToken =
			this.currentRecords().findLast(
				(record) => record.headers[0]?.[1] === "fence",
			)?.body ?? "";
		if (
			input.fencingToken !== undefined &&
			input.fencingToken !== fencingToken
		) {
			throw new FencingTokenMismatchError({
				message: "writer has been fenced",
				expectedFencingToken: fencingToken,
			});
		}
		this.directAppends.push(input);
		const start = this.nextSeqOnAppend;
		this.nextSeqOnAppend += input.records.length;
		this.directReadRecords.push(
			...input.records.map((record, index) =>
				appendRecordToReadRecord(start + index, record),
			),
		);
		return makeAck(start, this.nextSeqOnAppend);
	}

	async read(input?: {
		start?: { from?: { seqNum?: number; tailOffset?: number } };
		stop?: { limits?: { count?: number } };
	}) {
		const records = this.currentRecords();
		const from = input?.start?.from;
		const fromSeqNum =
			from?.tailOffset !== undefined
				? Math.max(0, records.length - from.tailOffset)
				: (from?.seqNum ?? 0);
		const count = input?.stop?.limits?.count ?? Number.POSITIVE_INFINITY;
		return {
			records: records
				.filter((record) => record.seqNum >= fromSeqNum)
				.slice(0, count),
		};
	}

	async readSession(input?: {
		start?: { from?: { seqNum?: number } };
		stop?: { waitSecs?: number };
	}) {
		this.readSessionCount += 1;
		const stream = this;
		const fromSeqNum = input?.start?.from?.seqNum ?? 0;
		const snapshot = input?.stop?.waitSecs === 0;
		let nextSeqNum = fromSeqNum;
		let idlePolls = 0;
		let cancelled = false;
		return new ReadableStream<ReadRecord<"string">>({
			async pull(controller) {
				while (!cancelled) {
					const record = stream
						.currentRecords()
						.find((record) => record.seqNum >= nextSeqNum);
					if (record) {
						controller.enqueue(record);
						nextSeqNum = record.seqNum + 1;
						idlePolls = 0;
						return;
					}
					idlePolls += 1;
					if (snapshot || stream.session.closeCount > 0 || idlePolls > 100) {
						controller.close();
						return;
					}
					await new Promise((resolve) => setTimeout(resolve, 0));
				}
			},
			cancel() {
				cancelled = true;
			},
		});
	}

	async close(): Promise<void> {
		this.closeCount += 1;
	}

	private currentRecords(): ReadRecord<"string">[] {
		return [
			...(this.options.readRecords ?? []),
			...this.directReadRecords,
			...this.session.readRecords,
			...(this.directAppends.length > 0
				? (this.options.readRecordsAfterClaim ?? [])
				: []),
		].sort((a, b) => a.seqNum - b.seqNum);
	}
}

const { activeStreamRef } = vi.hoisted(() => ({
	activeStreamRef: { current: null as FakeStream | null },
}));

vi.mock("@s2-dev/streamstore", async () => {
	const actual = await vi.importActual<typeof import("@s2-dev/streamstore")>(
		"@s2-dev/streamstore",
	);
	class MockS2 {
		basin() {
			return {
				streams: {
					create: async () => ({}),
				},
				stream: () => activeStreamRef.current,
			};
		}
	}
	return { ...actual, S2: MockS2 };
});

async function readSseFrames(response: Response): Promise<string[]> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const frames: string[] = [];
	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		const parts = buffer.split(/\r?\n\r?\n/);
		buffer = parts.pop() ?? "";
		for (const part of parts) {
			const data = part
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (data) frames.push(data);
		}
		if (done) break;
	}
	return frames;
}

function recordBody(record: AppendRecordType): string {
	return typeof record.body === "string"
		? record.body
		: new TextDecoder().decode(record.body);
}

function appendRecordToReadRecord(
	seqNum: number,
	record: AppendRecordType,
): ReadRecord<"string"> {
	return {
		seqNum,
		body: recordBody(record),
		headers: record.headers ?? [],
		timestamp: new Date(0),
	};
}

function messageText(message: {
	parts?: Array<{ type: string; content?: unknown }>;
}): string {
	return (message.parts ?? [])
		.filter(
			(part): part is { type: "text"; content: string } =>
				part.type === "text" && typeof part.content === "string",
		)
		.map((part) => part.content)
		.join("");
}

function chunkReadRecord(
	seqNum: number,
	chunk: Record<string, unknown>,
	timestamp = new Date(0),
): ReadRecord<"string"> {
	return {
		seqNum,
		body: JSON.stringify(chunk),
		headers: [],
		timestamp,
	};
}

function messageReadRecords(
	startSeqNum: number,
	message: { id: string; role: "user" | "assistant"; text: string },
	timestamp = new Date(0),
): ReadRecord<"string">[] {
	return [
		chunkReadRecord(
			startSeqNum,
			{
				type: "TEXT_MESSAGE_START",
				messageId: message.id,
				role: message.role,
			},
			timestamp,
		),
		chunkReadRecord(
			startSeqNum + 1,
			{
				type: "TEXT_MESSAGE_CONTENT",
				messageId: message.id,
				delta: message.text,
			},
			timestamp,
		),
		chunkReadRecord(
			startSeqNum + 2,
			{
				type: "TEXT_MESSAGE_END",
				messageId: message.id,
			},
			timestamp,
		),
	];
}

async function* okSource(): AsyncIterable<{
	type: string;
	timestamp?: number;
	[key: string]: unknown;
}> {
	yield { type: "RUN_STARTED", timestamp: 1, runId: "run", threadId: "thread" };
	yield {
		type: "TEXT_MESSAGE_CONTENT",
		timestamp: 2,
		messageId: "m1",
		delta: "hello",
	};
	yield {
		type: "RUN_FINISHED",
		timestamp: 3,
		runId: "run",
		threadId: "thread",
	};
}

async function* failingSource(): AsyncIterable<{
	type: string;
	timestamp?: number;
	[key: string]: unknown;
}> {
	yield { type: "RUN_STARTED", timestamp: 1, runId: "run", threadId: "thread" };
	yield {
		type: "TEXT_MESSAGE_CONTENT",
		timestamp: 2,
		messageId: "m1",
		delta: "partial",
	};
	throw new Error("model exploded");
}

describe("createResumableChat (tanstack-ai)", () => {
	it.each([0, 2])(
		"PR #398: stopping %i persisted active runs completes the real client",
		async (runCount) => {
			const { createResumableChat } = await import("../tanstack-ai/index.js");
			const runs = Array.from({ length: runCount }, (_, i) => ({
				runId: `run-${i}`,
				threadId: `thread-${i}`,
			}));
			const lateRun = { runId: "late-run", threadId: "late-thread" };
			const chunks = runCount
				? [
						{ type: "RUN_STARTED", runId: "completed", threadId: "old" },
						{ type: "RUN_FINISHED", runId: "completed", threadId: "old" },
						...runs.map((run) => ({ type: "RUN_STARTED", ...run })),
						{ type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" },
						{ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "Hello" },
					]
				: [];
			const stream = new FakeStream({
				readRecords: [
					{
						seqNum: 0,
						body: "session-persisted",
						headers: [["", "fence"]],
						timestamp: new Date(),
					},
					...chunks.map((chunk, index) => chunkReadRecord(index + 1, chunk)),
				],
			});
			activeStreamRef.current = stream;
			if (runCount) {
				const append = stream.append.bind(stream);
				const appendRun = (run: { runId: string; threadId: string }) =>
					append(
						AppendInput.create(
							[
								AppendRecord.string({
									body: JSON.stringify({ type: "RUN_STARTED", ...run }),
								}),
							],
							{ fencingToken: "session-persisted" },
						),
					);
				stream.append = async (input) => {
					const stopping = input.records.some((record) =>
						recordBody(record).startsWith("stop-"),
					);
					// The stopping snapshot must include this run, and exclude later writes.
					if (stopping) await appendRun(lateRun);
					const ack = await append(input);
					if (stopping) {
						await expect(
							appendRun({ runId: "blocked", threadId: "blocked" }),
						).rejects.toBeInstanceOf(FencingTokenMismatchError);
					}
					return ack;
				};
			}
			const config = { accessToken: "t", basin: "b", mode: "session" as const };
			const reader = createResumableChat(config);
			const stopper = createResumableChat(config);
			const onFinish = vi.fn();
			const client = new ChatClient({
				id: "stop-test",
				connection: createConnection({
					sendUrl: "/chat",
					subscribeUrl: "/chat/stream",
					fetch: async (_input, init) =>
						init?.method === "POST"
							? new Response(null, { status: 202 })
							: reader.replay("s"),
				}),
				onFinish,
			});
			try {
				const pendingSend = runCount ? undefined : client.sendMessage("hello");
				if (runCount) client.subscribe();
				await expect
					.poll(
						() =>
							runCount
								? client.getStatus() === "streaming"
								: client.getStatus() === "submitted",
						{ interval: 1, timeout: 1000 },
					)
					.toBe(true);
				expect(await stopper.stop("s")).toBe(true);
				await expect
					.poll(() => [client.getSessionGenerating(), client.getIsLoading()], {
						interval: 1,
						timeout: 1000,
					})
					.toEqual([false, false]);
				await pendingSend;
				if (runCount) expect(client.getStatus()).toBe("ready");
				expect(onFinish).toHaveBeenCalledTimes(runCount ? 1 : 0);
				const finished = stream.directReadRecords
					.filter((record) => record.headers.length === 0)
					.map((record) => JSON.parse(record.body))
					.filter((chunk) => chunk.type === "RUN_FINISHED");
				expect(finished).toMatchObject(
					runCount
						? [...runs, lateRun].map((run) => ({
								type: "RUN_FINISHED",
								...run,
							}))
						: [{ type: "RUN_FINISHED" }],
				);
			} finally {
				client.unsubscribe();
			}
		},
		5000,
	);

	it("persists chunks verbatim and replays them as SSE", async () => {
		const { createResumableChat } = await import("../tanstack-ai/index.js");
		const stream = new FakeStream();
		activeStreamRef.current = stream;

		const chat = createResumableChat({
			accessToken: "t",
			basin: "b",
			batchSize: 1,
			lingerDuration: 0,
		});

		const persisted: Promise<unknown>[] = [];
		const response = await chat.makeResumable("s", okSource(), {
			waitUntil: (p) => {
				persisted.push(p);
			},
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/event-stream");

		const frames = await readSseFrames(response);
		await Promise.all(persisted);

		// Each source chunk lands as a JSON-encoded SSE data frame, in order.
		const parsedTypes = frames.flatMap((data) => {
			try {
				return [(JSON.parse(data) as { type: string }).type];
			} catch {
				return [];
			}
		});
		expect(parsedTypes).toEqual([
			"RUN_STARTED",
			"TEXT_MESSAGE_CONTENT",
			"RUN_FINISHED",
		]);
	});

	it("returns 409 when the single-use fence claim is rejected", async () => {
		const { createResumableChat } = await import("../tanstack-ai/index.js");
		activeStreamRef.current = new FakeStream({ failFenceClaim: true });

		const chat = createResumableChat({ accessToken: "t", basin: "b" });
		const response = await chat.makeResumable("s", okSource());
		expect(response.status).toBe(409);
	});

	it("emits RUN_ERROR on the live SSE when the source throws", async () => {
		const { createResumableChat } = await import("../tanstack-ai/index.js");
		activeStreamRef.current = new FakeStream();

		const chat = createResumableChat({
			accessToken: "t",
			basin: "b",
			batchSize: 1,
			lingerDuration: 0,
			onError: () => "model exploded",
		});

		const persisted: Promise<unknown>[] = [];
		const response = await chat.makeResumable("s", failingSource(), {
			waitUntil: (p) => {
				persisted.push(p.catch(() => {}));
			},
		});
		expect(response.status).toBe(200);

		const frames = await readSseFrames(response);
		const errorFrame = frames.find((f) => f.includes('"type":"RUN_ERROR"'));
		expect(errorFrame).toBeDefined();
		expect(JSON.parse(errorFrame!)).toMatchObject({
			type: "RUN_ERROR",
			error: { message: "model exploded" },
		});

		await Promise.allSettled(persisted);
	});

	it("delivery: 'replay' returns 202 with no body and persists in the background", async () => {
		const { createResumableChat } = await import("../tanstack-ai/index.js");
		const stream = new FakeStream();
		activeStreamRef.current = stream;

		const chat = createResumableChat({
			accessToken: "t",
			basin: "b",
			batchSize: 1,
			lingerDuration: 0,
			mode: "session",
		});

		const persisted: Promise<unknown>[] = [];
		const response = await chat.makeResumable("s", okSource(), {
			delivery: "replay",
			waitUntil: (p) => {
				persisted.push(p);
			},
		});

		expect(response.status).toBe(202);
		expect(response.body).toBeNull();
		await Promise.all(persisted);
		expect(stream.session.records.length).toBeGreaterThan(0);
	});
});
