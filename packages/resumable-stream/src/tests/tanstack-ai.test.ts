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
	closeCount = 0;
	private seqNum = 0;

	async submit(input: AppendInput): Promise<SubmitTicket> {
		this.records.push(...input.records);
		const ack = makeAck(this.seqNum, this.seqNum + input.records.length);
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
	closeCount = 0;
	private nextSeqOnAppend: number;

	constructor(private readonly options: FakeStreamOptions = {}) {
		this.nextSeqOnAppend = options.readRecords?.length ?? 0;
	}

	async appendSession() {
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
		return makeAck(start, this.nextSeqOnAppend);
	}

	async readSession(input?: { start?: { from?: { seqNum?: number } } }) {
		const records = [
			...(this.options.readRecords ?? []),
			...(this.directAppends.length > 0
				? (this.options.readRecordsAfterClaim ?? [])
				: []),
		];
		const fromSeqNum = input?.start?.from?.seqNum ?? 0;
		return {
			[Symbol.asyncIterator]: async function* () {
				for (const record of records) {
					if (record.seqNum >= fromSeqNum) yield record;
				}
			},
		};
	}

	async close(): Promise<void> {
		this.closeCount += 1;
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

	it("normalizes TanStack UI messages while preserving ids and non-text parts", async () => {
		const { getLatestUserText, normalizeMessages, toTextMessages } =
			await import("../tanstack-ai.js");

		const messages = normalizeMessages([
			{
				id: "u1",
				role: "user",
				parts: [
					{ type: "text", content: "hello" },
					{ type: "file", url: "s2://attachment" },
				],
			},
		]);

		expect(messages).toEqual([
			{
				id: "u1",
				role: "user",
				parts: [
					{ type: "text", content: "hello" },
					{ type: "file", url: "s2://attachment" },
				],
			},
		]);
		expect(getLatestUserText(messages)).toBe("hello");
		expect(toTextMessages(messages)).toEqual([
			{ role: "user", content: "hello" },
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

	it("makeSessionResponse appends new message chunks and returns 202", async () => {
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
		const response = await chat.makeSessionResponse("s", {
			messages: [
				{
					id: "u1",
					role: "user",
					parts: [{ type: "text", content: "hi" }],
				},
			],
			source: () => okSource(),
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

	it("session replay snapshot rebuilds tool, approval, and reasoning parts", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		const ts = new Date(0);
		activeStreamRef.current = new FakeStream({
			readRecords: [
				...messageReadRecords(
					0,
					{ id: "u1", role: "user", text: "find s2" },
					ts,
				),
				chunkReadRecord(
					3,
					{
						type: "RUN_STARTED",
						runId: "r1",
					},
					ts,
				),
				chunkReadRecord(
					4,
					{
						type: "TEXT_MESSAGE_START",
						messageId: "a1",
						role: "assistant",
					},
					ts,
				),
				chunkReadRecord(
					5,
					{
						type: "TEXT_MESSAGE_CONTENT",
						messageId: "a1",
						delta: "I will look. ",
					},
					ts,
				),
				chunkReadRecord(
					6,
					{
						type: "TOOL_CALL_START",
						toolCallId: "tool-1",
						toolCallName: "lookup",
						parentMessageId: "a1",
					},
					ts,
				),
				chunkReadRecord(
					7,
					{
						type: "TOOL_CALL_ARGS",
						toolCallId: "tool-1",
						delta: '{"query":"s2"}',
					},
					ts,
				),
				chunkReadRecord(
					8,
					{
						type: "CUSTOM",
						name: "approval-requested",
						value: {
							toolCallId: "tool-1",
							toolName: "lookup",
							input: { query: "s2" },
							approval: { id: "approval-1", needsApproval: true },
						},
					},
					ts,
				),
				chunkReadRecord(
					9,
					{
						type: "TOOL_CALL_END",
						toolCallId: "tool-1",
						toolCallName: "lookup",
						input: { query: "s2" },
						result: '{"answer":42}',
					},
					ts,
				),
				chunkReadRecord(
					10,
					{
						type: "REASONING_MESSAGE_CONTENT",
						delta: "checked cache",
					},
					ts,
				),
				chunkReadRecord(
					11,
					{
						type: "RUN_FINISHED",
						runId: "r1",
						finishReason: "stop",
					},
					ts,
				),
			],
		});

		const chat = createResumableChat({
			accessToken: "t",
			basin: "b",
			mode: "session",
		});

		const response = await chat.replay("s");
		const [frame] = await readSseFrames(response);
		const snapshot = JSON.parse(frame!);
		expect(snapshot.messages).toHaveLength(2);
		expect(snapshot.messages[1]).toMatchObject({
			id: "a1",
			role: "assistant",
			parts: expect.arrayContaining([
				expect.objectContaining({ type: "text", content: "I will look. " }),
				expect.objectContaining({
					type: "tool-call",
					id: "tool-1",
					name: "lookup",
					arguments: '{"query":"s2"}',
					approval: { id: "approval-1", needsApproval: true },
				}),
				expect.objectContaining({ type: "tool-result", toolCallId: "tool-1" }),
				expect.objectContaining({ type: "thinking", content: "checked cache" }),
			]),
		});
	});

	it("makeSessionResponse uses current session messages for the model and appends only the new message", async () => {
		const { createResumableChat, toTextMessages } = await import(
			"../tanstack-ai.js"
		);
		const ts = new Date(0);
		const stream = new FakeStream({
			readRecords: [
				...messageReadRecords(0, { id: "u1", role: "user", text: "first" }, ts),
				...messageReadRecords(
					3,
					{ id: "a1", role: "assistant", text: "first answer" },
					ts,
				),
				...messageReadRecords(
					6,
					{ id: "u2", role: "user", text: "newer tab" },
					ts,
				),
			],
		});
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
					parts: [{ type: "text", content: "first" }],
				},
				{
					id: "a1",
					role: "assistant",
					parts: [{ type: "text", content: "first answer" }],
				},
				{
					id: "u3",
					role: "user",
					parts: [{ type: "text", content: "stale tab send" }],
				},
				{
					id: "client-a3",
					role: "assistant",
					parts: [{ type: "text", content: "do not trust client assistant" }],
				},
			],
			source: (messages) => {
				sourceMessages.push(...toTextMessages(messages));
				return okSource();
			},
			waitUntil: (p) => persisted.push(p),
		});

		expect(response.status).toBe(202);
		await Promise.all(persisted);

		const storedTypes = stream.session.records.slice(0, 4).map((record) => {
			const chunk = JSON.parse(recordBody(record));
			return [chunk.type, chunk.messageId, chunk.delta];
		});
		expect(storedTypes).toEqual([
			["TEXT_MESSAGE_START", "u3", undefined],
			["TEXT_MESSAGE_CONTENT", "u3", "stale tab send"],
			["TEXT_MESSAGE_END", "u3", undefined],
			["RUN_STARTED", undefined, undefined],
		]);
		expect(sourceMessages).toEqual([
			{ role: "user", content: "first" },
			{ role: "assistant", content: "first answer" },
			{ role: "user", content: "newer tab" },
			{ role: "user", content: "stale tab send" },
		]);
	});

	it("makeSessionResponse skips duplicate completed messages", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		const ts = new Date(0);
		const stream = new FakeStream({
			readRecords: [
				...messageReadRecords(
					0,
					{ id: "u1", role: "user", text: "already stored" },
					ts,
				),
				...messageReadRecords(
					3,
					{ id: "a1", role: "assistant", text: "already answered" },
					ts,
				),
			],
		});
		activeStreamRef.current = stream;

		const chat = createResumableChat({
			accessToken: "t",
			basin: "b",
			batchSize: 1,
			lingerDuration: 0,
			mode: "session",
		});

		let sourceCalled = false;
		const persisted: Promise<unknown>[] = [];
		const response = await chat.makeSessionResponse("s", {
			messages: [
				{
					id: "u1",
					role: "user",
					parts: [{ type: "text", content: "already stored" }],
				},
			],
			source: () => {
				sourceCalled = true;
				return okSource();
			},
			waitUntil: (p) => persisted.push(p),
		});

		expect(response.status).toBe(202);
		await Promise.all(persisted);
		expect(sourceCalled).toBe(false);
		expect(
			stream.session.records
				.map(recordBody)
				.filter((body) => body.startsWith("{")),
		).toEqual([]);
	});

	it("makeSessionResponse can retry a user message that has no assistant answer", async () => {
		const { createResumableChat, toTextMessages } = await import(
			"../tanstack-ai.js"
		);
		const ts = new Date(0);
		const stream = new FakeStream({
			readRecords: [
				...messageReadRecords(
					0,
					{ id: "u1", role: "user", text: "needs answer" },
					ts,
				),
			],
		});
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
					parts: [{ type: "text", content: "needs answer" }],
				},
			],
			source: (messages) => {
				sourceMessages.push(...toTextMessages(messages));
				return okSource();
			},
			waitUntil: (p) => persisted.push(p),
		});

		expect(response.status).toBe(202);
		await Promise.all(persisted);
		const storedTypes = stream.session.records.slice(0, 2).map((record) => {
			const chunk = JSON.parse(recordBody(record));
			return chunk.type;
		});
		expect(storedTypes).toEqual(["RUN_STARTED", "TEXT_MESSAGE_CONTENT"]);
		expect(sourceMessages).toEqual([{ role: "user", content: "needs answer" }]);
	});

	it("makeSessionResponse reads the durable snapshot after claiming the session", async () => {
		const { createResumableChat, toTextMessages } = await import(
			"../tanstack-ai.js"
		);
		const ts = new Date(0);
		const stream = new FakeStream({
			readRecords: [
				...messageReadRecords(0, { id: "u1", role: "user", text: "first" }, ts),
				...messageReadRecords(
					3,
					{ id: "a1", role: "assistant", text: "first answer" },
					ts,
				),
			],
			readRecordsAfterClaim: [
				...messageReadRecords(
					6,
					{ id: "u2", role: "user", text: "other tab" },
					ts,
				),
				...messageReadRecords(
					9,
					{ id: "a2", role: "assistant", text: "other answer" },
					ts,
				),
			],
		});
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
					parts: [{ type: "text", content: "first" }],
				},
				{
					id: "a1",
					role: "assistant",
					parts: [{ type: "text", content: "first answer" }],
				},
				{
					id: "u3",
					role: "user",
					parts: [{ type: "text", content: "current tab" }],
				},
			],
			source: (messages) => {
				sourceMessages.push(...toTextMessages(messages));
				return okSource();
			},
			waitUntil: (p) => persisted.push(p),
		});

		expect(response.status).toBe(202);
		await Promise.all(persisted);

		const firstThreeChunks = stream.session.records
			.slice(0, 3)
			.map((record) => JSON.parse(recordBody(record)));
		expect(firstThreeChunks).toMatchObject([
			{ type: "TEXT_MESSAGE_START", messageId: "u3", role: "user" },
			{ type: "TEXT_MESSAGE_CONTENT", messageId: "u3", delta: "current tab" },
			{ type: "TEXT_MESSAGE_END", messageId: "u3" },
		]);
		expect(sourceMessages).toEqual([
			{ role: "user", content: "first" },
			{ role: "assistant", content: "first answer" },
			{ role: "user", content: "other tab" },
			{ role: "assistant", content: "other answer" },
			{ role: "user", content: "current tab" },
		]);
	});

	it("session replay bootstraps with a messages snapshot when no cursor is provided", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		const ts = new Date(0);
		activeStreamRef.current = new FakeStream({
			readRecords: [
				...messageReadRecords(0, { id: "u1", role: "user", text: "hi" }, ts),
				...messageReadRecords(
					3,
					{ id: "a1", role: "assistant", text: "hello" },
					ts,
				),
			],
		});

		const chat = createResumableChat({
			accessToken: "t",
			basin: "b",
			mode: "session",
		});
		const response = await chat.replay("s");
		expect(response.status).toBe(200);

		const text = await response.text();
		expect(text.startsWith("id: 6\ndata: ")).toBe(true);
		const payload = JSON.parse(text.match(/^id: 6\ndata: (.*)\n\n$/)![1]!);
		expect(payload).toMatchObject({
			type: "MESSAGES_SNAPSHOT",
			messages: [
				{ id: "u1", role: "user", parts: [{ type: "text", content: "hi" }] },
				{
					id: "a1",
					role: "assistant",
					parts: [{ type: "text", content: "hello" }],
				},
			],
		});
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
