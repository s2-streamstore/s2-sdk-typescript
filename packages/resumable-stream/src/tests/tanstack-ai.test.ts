import type {
	AppendAck,
	AppendInput,
	AppendRecord as AppendRecordType,
	ReadRecord,
} from "@s2-dev/streamstore";
import { describe, expect, it, vi } from "vitest";

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
		return {
			[Symbol.asyncIterator]: async function* () {
				let nextSeqNum = fromSeqNum;
				let idlePolls = 0;
				while (true) {
					const records = stream
						.currentRecords()
						.filter((record) => record.seqNum >= nextSeqNum);
					if (records.length > 0) {
						for (const record of records) {
							yield record;
							nextSeqNum = record.seqNum + 1;
						}
						idlePolls = 0;
						continue;
					}
					if (snapshot || stream.session.closeCount > 0) return;
					idlePolls += 1;
					if (idlePolls > 100) return;
					await new Promise((resolve) => setTimeout(resolve, 0));
				}
			},
		};
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
	yield { type: "RUN_STARTED", timestamp: 1 };
	yield {
		type: "TEXT_MESSAGE_CONTENT",
		timestamp: 2,
		messageId: "m1",
		delta: "hello",
	};
	yield { type: "RUN_FINISHED", timestamp: 3 };
}

async function* failingSource(): AsyncIterable<{
	type: string;
	timestamp?: number;
	[key: string]: unknown;
}> {
	yield { type: "RUN_STARTED", timestamp: 1 };
	yield {
		type: "TEXT_MESSAGE_CONTENT",
		timestamp: 2,
		messageId: "m1",
		delta: "partial",
	};
	throw new Error("model exploded");
}

describe("createResumableChat (tanstack-ai)", () => {
	it("exposes the documented helper shape", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		const chat = createResumableChat({
			accessToken: "test-token",
			basin: "test-basin",
		});
		expect(typeof chat.makeResumable).toBe("function");
		expect(typeof chat.replay).toBe("function");
		expect(typeof chat.makeSessionResponse).toBe("function");
	});

	it("passes TanStack UI messages through while preserving non-text parts", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		activeStreamRef.current = new FakeStream();

		const chat = createResumableChat({
			accessToken: "t",
			basin: "b",
			batchSize: 1,
			lingerDuration: 0,
			mode: "session",
		});

		const persisted: Promise<unknown>[] = [];
		let sourceMessages: unknown[] = [];
		await chat.makeSessionResponse("s", {
			messages: [
				{
					id: "u1",
					role: "user",
					parts: [
						{ type: "text", content: "hello" },
						{
							type: "image",
							source: { type: "url", value: "s2://attachment" },
						},
					],
				},
			],
			source: (messages) => {
				sourceMessages = messages;
				return okSource();
			},
			waitUntil: (p) => persisted.push(p),
		});
		await Promise.all(persisted);

		expect(sourceMessages).toEqual([
			{
				id: "u1",
				role: "user",
				parts: [
					{ type: "text", content: "hello" },
					{
						type: "image",
						source: { type: "url", value: "s2://attachment" },
					},
				],
			},
		]);
	});

	it("returns 409 when the single-use fence claim is rejected", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		activeStreamRef.current = new FakeStream({ failFenceClaim: true });

		const chat = createResumableChat({ accessToken: "t", basin: "b" });
		const response = await chat.makeResumable("s", okSource());
		expect(response.status).toBe(409);
	});

	it("emits RUN_ERROR on the live SSE when the source throws", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
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
		expect(frames).not.toContain("[DONE]");

		const errorFrame = frames.find((f) => f.includes('"type":"RUN_ERROR"'));
		expect(errorFrame).toBeDefined();
		expect(JSON.parse(errorFrame!)).toMatchObject({
			type: "RUN_ERROR",
			error: { message: "model exploded" },
		});

		await Promise.allSettled(persisted);
	});

	it("can use replay delivery and return 202 without a live SSE body", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
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

	it("makeSessionResponse waits for persistence without waitUntil", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		const stream = new FakeStream();
		activeStreamRef.current = stream;

		const chat = createResumableChat({
			accessToken: "t",
			basin: "b",
			batchSize: 1,
			lingerDuration: 0,
			mode: "session",
		});

		let releaseSource!: () => void;
		const sourceGate = new Promise<void>((resolve) => {
			releaseSource = resolve;
		});
		const responsePromise = chat.makeSessionResponse("s", {
			messages: [
				{
					id: "u1",
					role: "user",
					parts: [{ type: "text", content: "hi" }],
				},
			],
			source: () =>
				(async function* () {
					await sourceGate;
					yield* okSource();
				})(),
		});

		const beforeRelease = await Promise.race([
			responsePromise.then(() => "settled"),
			new Promise<"pending">((resolve) => setTimeout(resolve, 0, "pending")),
		]);
		expect(beforeRelease).toBe("pending");

		releaseSource();
		const response = await responsePromise;
		expect(response.status).toBe(202);
		expect(stream.session.records.map(recordBody).join("\n")).toContain(
			'"type":"RUN_FINISHED"',
		);
	});

	it("makeSessionResponse stores latest user message events and returns 202", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
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
		const sourceMessages: unknown[] = [];
		const response = await chat.makeSessionResponse("s", {
			messages: [
				{
					id: "u1",
					role: "user",
					parts: [{ type: "text", content: "hi" }],
				},
			],
			source: (messages) => {
				sourceMessages.push(
					...messages.map((message) => ({
						role: message.role,
						content: messageText(message),
					})),
				);
				return okSource();
			},
			waitUntil: (p) => persisted.push(p),
		});

		expect(response.status).toBe(202);
		await Promise.all(persisted);
		expect(
			stream.session.records.slice(0, 3).map((record) => {
				const chunk = JSON.parse(recordBody(record));
				return {
					type: chunk.type,
					messageId: chunk.messageId,
					role: chunk.role,
					delta: chunk.delta,
				};
			}),
		).toEqual([
			{
				type: "TEXT_MESSAGE_START",
				messageId: "u1",
				role: "user",
				delta: undefined,
			},
			{
				type: "TEXT_MESSAGE_CONTENT",
				messageId: "u1",
				role: undefined,
				delta: "hi",
			},
			{
				type: "TEXT_MESSAGE_END",
				messageId: "u1",
				role: undefined,
				delta: undefined,
			},
		]);
		expect(sourceMessages).toEqual([{ role: "user", content: "hi" }]);
	});

	it("stores text content chunks as deltas only", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		const stream = new FakeStream();
		activeStreamRef.current = stream;

		const chat = createResumableChat({
			accessToken: "t",
			basin: "b",
			batchSize: 1,
			lingerDuration: 0,
		});

		const persisted: Promise<unknown>[] = [];
		const response = await chat.makeResumable(
			"s",
			(async function* () {
				yield {
					type: "TEXT_MESSAGE_CONTENT",
					messageId: "a1",
					delta: "h",
					content: "h",
				};
			})(),
			{
				delivery: "replay",
				waitUntil: (p) => persisted.push(p),
			},
		);

		expect(response.status).toBe(202);
		await Promise.all(persisted);
		const storedChunk = JSON.parse(recordBody(stream.session.records[0]!));
		expect(storedChunk).toEqual({
			type: "TEXT_MESSAGE_CONTENT",
			messageId: "a1",
			delta: "h",
		});
	});

	it("returns 204 from replay when there is no active generation", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		activeStreamRef.current = new FakeStream();

		const chat = createResumableChat({ accessToken: "t", basin: "b" });
		const response = await chat.replay("s");
		expect(response.status).toBe(204);
	});

	it("active replay tags chunks and can resume from a sequence number", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		const ts = new Date(0);
		activeStreamRef.current = new FakeStream({
			readRecords: [
				{
					seqNum: 0,
					body: "holder",
					headers: [["", "fence"]],
					timestamp: ts,
				},
				{ seqNum: 1, body: "old", headers: [], timestamp: ts },
				{ seqNum: 2, body: "new", headers: [], timestamp: ts },
			],
		});

		const chat = createResumableChat({ accessToken: "t", basin: "b" });
		const response = await chat.replay("s", { fromSeqNum: 2 });

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("id: 3\ndata: new\n\n");
	});

	it("makeSessionResponse passes client tool results to source without storing snapshots", async () => {
		const { convertMessagesToModelMessages } = await import("@tanstack/ai");
		const { createResumableChat } = await import("../tanstack-ai.js");
		const stream = new FakeStream();
		activeStreamRef.current = stream;

		const chat = createResumableChat({
			accessToken: "t",
			basin: "b",
			batchSize: 1,
			lingerDuration: 0,
			mode: "session",
		});

		const sourceMessages: unknown[] = [];
		const persisted: Promise<unknown>[] = [];
		const response = await chat.makeSessionResponse("s", {
			messages: [
				{
					id: "u1",
					role: "user",
					parts: [{ type: "text", content: "needs lookup" }],
				},
				{
					id: "a1",
					role: "assistant",
					parts: [
						{
							type: "tool-call",
							id: "tool-1",
							name: "lookup",
							arguments: "{}",
							state: "input-complete",
							output: { answer: 42 },
						},
						{
							type: "tool-result",
							toolCallId: "tool-1",
							content: '{"answer":42}',
							state: "complete",
						},
					],
				},
			],
			source: (messages) => {
				sourceMessages.push(
					...convertMessagesToModelMessages(
						messages as Parameters<typeof convertMessagesToModelMessages>[0],
					),
				);
				return okSource();
			},
			waitUntil: (p) => persisted.push(p),
		});

		expect(response.status).toBe(202);
		await Promise.all(persisted);
		const firstStoredChunk = JSON.parse(recordBody(stream.session.records[0]!));
		expect(firstStoredChunk.type).toBe("RUN_STARTED");
		expect(sourceMessages).toEqual([
			{ role: "user", content: "needs lookup" },
			{
				role: "assistant",
				content: null,
				toolCalls: [
					{
						id: "tool-1",
						type: "function",
						function: { name: "lookup", arguments: "{}" },
					},
				],
			},
			{ role: "tool", content: '{"answer":42}', toolCallId: "tool-1" },
		]);
	});

	it("session replay tails records from the beginning when no cursor is provided", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		const ts = new Date(0);
		activeStreamRef.current = new FakeStream({
			readRecords: [
				...messageReadRecords(0, {
					id: "u1",
					role: "user",
					text: "hi",
				}),
				chunkReadRecord(3, { type: "RUN_STARTED", runId: "r1" }, ts),
			],
		});

		const chat = createResumableChat({
			accessToken: "t",
			basin: "b",
			mode: "session",
		});
		const response = await chat.replay("s");
		expect(response.status).toBe(200);

		expect(await response.text()).toContain(
			'id: 3\ndata: {"type":"MESSAGES_SNAPSHOT"',
		);
		expect(
			await chat.replay("s", { fromSeqNum: 3 }).then((r) => r.text()),
		).toBe('id: 4\ndata: {"type":"RUN_STARTED","runId":"r1"}\n\n');
	});

	it("session replay hydrates completed history with one snapshot", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		activeStreamRef.current = new FakeStream({
			readRecords: [
				...messageReadRecords(0, {
					id: "u1",
					role: "user",
					text: "hi",
				}),
				chunkReadRecord(3, { type: "RUN_STARTED", runId: "r1" }),
				...messageReadRecords(4, {
					id: "a1",
					role: "assistant",
					text: "hello",
				}),
				chunkReadRecord(7, { type: "RUN_FINISHED", runId: "r1" }),
			],
		});

		const chat = createResumableChat({
			accessToken: "t",
			basin: "b",
			mode: "session",
		});
		const response = await chat.replay("s");

		const frames = await readSseFrames(response);
		expect(frames).toHaveLength(1);
		const snapshot = JSON.parse(frames[0]!);
		expect(snapshot).toMatchObject({
			type: "MESSAGES_SNAPSHOT",
			messages: [
				{ id: "u1", role: "user" },
				{
					id: "a1",
					role: "assistant",
					parts: [{ type: "text", content: "hello" }],
				},
			],
		});
	});

	it("session replay keeps the active run streaming after compacted history", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		activeStreamRef.current = new FakeStream({
			readRecords: [
				...messageReadRecords(0, {
					id: "u1",
					role: "user",
					text: "hi",
				}),
				chunkReadRecord(3, { type: "RUN_STARTED", runId: "r1" }),
				...messageReadRecords(4, {
					id: "a1",
					role: "assistant",
					text: "hello",
				}),
				chunkReadRecord(7, { type: "RUN_FINISHED", runId: "r1" }),
				...messageReadRecords(8, {
					id: "u2",
					role: "user",
					text: "again",
				}),
				chunkReadRecord(11, { type: "RUN_STARTED", runId: "r2" }),
				chunkReadRecord(12, {
					type: "TEXT_MESSAGE_CONTENT",
					messageId: "a2",
					delta: "streaming",
				}),
			],
		});

		const chat = createResumableChat({
			accessToken: "t",
			basin: "b",
			mode: "session",
		});
		const response = await chat.replay("s");

		const chunks = (await readSseFrames(response)).map((frame) =>
			JSON.parse(frame),
		);
		expect(chunks.map((chunk) => chunk.type)).toEqual([
			"MESSAGES_SNAPSHOT",
			"RUN_STARTED",
			"TEXT_MESSAGE_CONTENT",
		]);
		expect(chunks[0]).toMatchObject({
			messages: [
				{ id: "u1", role: "user" },
				{ id: "a1", role: "assistant" },
				{ id: "u2", role: "user" },
			],
		});
	});

	it("stopSession aborts the active generation without scanning S2", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		const stream = new FakeStream();
		activeStreamRef.current = stream;

		const chat = createResumableChat({
			accessToken: "t",
			basin: "b",
			batchSize: 1,
			lingerDuration: 0,
			mode: "session",
			enableStop: true,
		});

		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const responsePromise = chat.makeSessionResponse("s", {
			messages: [
				{
					id: "u1",
					role: "user",
					parts: [{ type: "text", content: "hi" }],
				},
			],
			source: (_messages, { signal }) =>
				(async function* () {
					yield { type: "RUN_STARTED", runId: "r1" };
					markStarted();
					yield {
						type: "TEXT_MESSAGE_CONTENT",
						messageId: "a1",
						delta: "streaming",
					};
					await new Promise<void>((resolve) => {
						signal.addEventListener("abort", () => resolve(), { once: true });
					});
				})(),
		});

		await started;
		const response = await chat.stopSession("s");
		const postResponse = await responsePromise;

		expect(response.status).toBe(202);
		expect(postResponse.status).toBe(202);
		expect(stream.readSessionCount).toBe(0);
		expect(stream.directAppends).toHaveLength(1);
		const storedChunks = stream.session.records.flatMap((record) => {
			const body = recordBody(record);
			return body.startsWith("{") ? [JSON.parse(body)] : [];
		});
		const stopChunk = storedChunks.find(
			(chunk) => chunk.type === "RUN_FINISHED",
		);
		expect(stopChunk).toMatchObject({
			type: "RUN_FINISHED",
			runId: "r1",
			finishReason: "stop",
		});
	});

	it("stopSession is a no-op unless local stop tracking is enabled", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		const stream = new FakeStream();
		activeStreamRef.current = stream;

		const chat = createResumableChat({
			accessToken: "t",
			basin: "b",
			batchSize: 1,
			lingerDuration: 0,
			mode: "session",
		});

		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let releaseSource!: () => void;
		const sourceReleased = new Promise<void>((resolve) => {
			releaseSource = resolve;
		});
		const persisted: Promise<unknown>[] = [];

		const response = await chat.makeSessionResponse("s", {
			messages: [
				{
					id: "u1",
					role: "user",
					parts: [{ type: "text", content: "hi" }],
				},
			],
			source: () =>
				(async function* () {
					yield { type: "RUN_STARTED", runId: "r1" };
					markStarted();
					await sourceReleased;
					yield { type: "RUN_FINISHED", runId: "r1" };
				})(),
			waitUntil: (promise) => persisted.push(promise),
		});

		expect(response.status).toBe(202);
		await started;
		expect((await chat.stopSession("s")).status).toBe(204);
		expect(stream.readSessionCount).toBe(0);

		releaseSource();
		await Promise.all(persisted);
	});

	it("session replay yields data from every generation from an explicit cursor", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		const ts = new Date(0);
		activeStreamRef.current = new FakeStream({
			readRecords: [
				{
					seqNum: 0,
					body: "holder-1",
					headers: [["", "fence"]],
					timestamp: ts,
				},
				{ seqNum: 1, body: "gen-1-a", headers: [], timestamp: ts },
				{
					seqNum: 2,
					body: "end-AAAA",
					headers: [["", "fence"]],
					timestamp: ts,
				},
				{
					seqNum: 3,
					body: "holder-2",
					headers: [["", "fence"]],
					timestamp: ts,
				},
				{ seqNum: 4, body: "gen-2-a", headers: [], timestamp: ts },
				{
					seqNum: 5,
					body: "end-BBBB",
					headers: [["", "fence"]],
					timestamp: ts,
				},
			],
		});

		const chat = createResumableChat({
			accessToken: "t",
			basin: "b",
			mode: "session",
		});
		const response = await chat.replay("s", { fromSeqNum: 0 });
		expect(response.status).toBe(200);

		const frames = await readSseFrames(response);
		expect(frames).toEqual(["gen-1-a", "gen-2-a"]);
	});

	it("session replay can start from a provided sequence number", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		const ts = new Date(0);
		activeStreamRef.current = new FakeStream({
			readRecords: [
				{
					seqNum: 0,
					body: "holder-1",
					headers: [["", "fence"]],
					timestamp: ts,
				},
				{ seqNum: 1, body: "old", headers: [], timestamp: ts },
				{ seqNum: 2, body: "new", headers: [], timestamp: ts },
			],
		});

		const chat = createResumableChat({
			accessToken: "t",
			basin: "b",
			mode: "session",
		});
		const response = await chat.replay("s", { fromSeqNum: 2 });
		expect(response.status).toBe(200);

		const frames = await readSseFrames(response);
		expect(frames).toEqual(["new"]);
	});

	it("session replay tags each frame with the next S2 sequence number", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		const ts = new Date(0);
		activeStreamRef.current = new FakeStream({
			readRecords: [
				{
					seqNum: 0,
					body: "holder",
					headers: [["", "fence"]],
					timestamp: ts,
				},
				{ seqNum: 1, body: "first", headers: [], timestamp: ts },
				{ seqNum: 2, body: "second", headers: [], timestamp: ts },
			],
		});

		const chat = createResumableChat({
			accessToken: "t",
			basin: "b",
			mode: "session",
		});

		const response = await chat.replay("s", { fromSeqNum: 0 });
		expect(await response.text()).toBe(
			"id: 2\ndata: first\n\nid: 3\ndata: second\n\n",
		);
	});
});
