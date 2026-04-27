import type { AppendAck, AppendInput, ReadInput } from "@s2-dev/streamstore";
import { describe, expect, it } from "vitest";
import {
	createHttpConnection,
	createS2Connection,
	createS2SessionHandler,
	decodeS2SessionEvent,
	encodeS2SessionEvent,
	materializeSessionSnapshot,
	readSseResponse,
	type S2SessionRecord,
	type StreamChunk,
	sessionRecordsToSseResponse,
	streamToSseResponse,
} from "../tanstack-ai.js";

async function* chunks(): AsyncIterable<StreamChunk> {
	yield { type: "RUN_STARTED", timestamp: 1 };
	yield {
		type: "TEXT_MESSAGE_CONTENT",
		timestamp: 2,
		messageId: "m1",
		delta: "hello",
	};
	yield { type: "RUN_FINISHED", timestamp: 3 };
}

async function* textChunks(...deltas: string[]): AsyncIterable<StreamChunk> {
	for (const [index, delta] of deltas.entries()) {
		yield {
			type: "TEXT_MESSAGE_CONTENT",
			timestamp: index + 1,
			messageId: "m1",
			delta,
		};
	}
}

class FakeSessionStream {
	appended: AppendInput[] = [];
	records: Array<{
		seqNum: number;
		body: string;
		headers: ReadonlyArray<readonly [string, string]>;
		timestamp: Date;
	}>;

	constructor(records: FakeSessionStream["records"] = []) {
		this.records = records;
	}

	async append(input: AppendInput): Promise<AppendAck> {
		this.appended.push(input);
		const start = this.records.length;
		for (const record of input.records) {
			this.records.push({
				seqNum: this.records.length,
				body: String(record.body ?? ""),
				headers: record.headers,
				timestamp: record.timestamp ?? new Date("2026-04-27T00:00:00.000Z"),
			});
		}
		return {
			start: {
				seqNum: start,
				timestamp: new Date("2026-04-27T00:00:00.000Z"),
			},
			end: {
				seqNum: this.records.length,
				timestamp: new Date("2026-04-27T00:00:00.000Z"),
			},
			tail: {
				seqNum: this.records.length,
				timestamp: new Date("2026-04-27T00:00:00.000Z"),
			},
		};
	}

	async checkTail() {
		return {
			tail: {
				seqNum: this.records.length,
				timestamp: new Date("2026-04-27T00:00:00.000Z"),
			},
		};
	}

	async read(input?: ReadInput) {
		const from = input?.start?.from;
		const start = from && "seqNum" in from ? from.seqNum : 0;
		const count = input?.stop?.limits?.count ?? 1000;
		return {
			records: this.records.slice(start, start + count),
			tail: {
				seqNum: this.records.length,
				timestamp: new Date("2026-04-27T00:00:00.000Z"),
			},
		};
	}
}

function sessionRecord(seqNum: number, event: S2SessionRecord["event"]) {
	return {
		seqNum,
		body: encodeS2SessionEvent(event),
		headers: [],
		timestamp: new Date("2026-04-27T00:00:00.000Z"),
	};
}

describe("streamToSseResponse", () => {
	it("serializes TanStack AI chunks as SSE data frames", async () => {
		const response = streamToSseResponse(chunks());

		expect(response.headers.get("Content-Type")).toBe("text/event-stream");
		expect(await response.text()).toBe(
			[
				'data: {"type":"RUN_STARTED","timestamp":1}',
				'data: {"type":"TEXT_MESSAGE_CONTENT","timestamp":2,"messageId":"m1","delta":"hello"}',
				'data: {"type":"RUN_FINISHED","timestamp":3}',
				"data: [DONE]",
				"",
			].join("\n\n"),
		);
	});

	it("parses TanStack AI SSE frames back into chunks", async () => {
		const response = streamToSseResponse(chunks());

		const parsed: StreamChunk[] = [];
		for await (const chunk of readSseResponse(response)) {
			parsed.push(chunk);
		}

		expect(parsed).toEqual([
			{ type: "RUN_STARTED", timestamp: 1 },
			{
				type: "TEXT_MESSAGE_CONTENT",
				timestamp: 2,
				messageId: "m1",
				delta: "hello",
			},
			{ type: "RUN_FINISHED", timestamp: 3 },
		]);
	});

	it("creates a structural TanStack AI connection adapter", async () => {
		const requests: Request[] = [];
		const connection = createHttpConnection({
			url: "https://example.test/chat",
			streamName: "session-1",
			fetchClient: async (input, init) => {
				requests.push(new Request(input, init));
				return streamToSseResponse(chunks());
			},
		});

		const parsed: StreamChunk[] = [];
		for await (const chunk of connection.connect(
			[{ role: "user", content: "hello" }],
			{ mode: "test" },
		)) {
			parsed.push(chunk);
		}

		expect(parsed[0]).toEqual({ type: "RUN_STARTED", timestamp: 1 });
		expect(requests).toHaveLength(1);
		expect(await requests[0]!.json()).toEqual({
			messages: [{ role: "user", content: "hello" }],
			data: { mode: "test" },
			streamName: "session-1",
		});
	});

	it("round-trips S2 session events", () => {
		const event: S2SessionRecord["event"] = {
			kind: "chunk",
			runId: "run-1",
			chunk: {
				type: "TEXT_MESSAGE_CONTENT",
				messageId: "m1",
				delta: "hi",
			},
			timestamp: "2026-04-27T00:00:00.000Z",
		};

		expect(decodeS2SessionEvent(encodeS2SessionEvent(event))).toEqual(event);
	});

	it("serializes session records as resumable SSE events", async () => {
		const response = sessionRecordsToSseResponse(
			(async function* () {
				yield {
					seqNum: 2,
					timestamp: "2026-04-27T00:00:00.000Z",
					event: {
						kind: "run-finish",
						runId: "run-1",
						timestamp: "2026-04-27T00:00:00.000Z",
					},
				} satisfies S2SessionRecord;
			})(),
		);

		expect(await response.text()).toBe(
			[
				'data: {"seqNum":2,"timestamp":"2026-04-27T00:00:00.000Z","event":{"kind":"run-finish","runId":"run-1","timestamp":"2026-04-27T00:00:00.000Z"}}',
				"",
			].join("\n\n"),
		);
	});

	it("creates an S2 session connection that appends then tails by seqNum", async () => {
		const requests: Array<{ input: string; init?: RequestInit }> = [];
		const connection = createS2Connection({
			appendUrl: "/api/chat/append",
			tailUrl: "/api/chat/tail?transport=s2",
			streamName: "session-1",
			fetchClient: async (input, init) => {
				const request = { input: String(input), init };
				requests.push(request);
				if (init?.method === "POST") {
					return Response.json(
						{ streamName: "session-1", runId: "run-1", nextSeqNum: 2 },
						{ status: 202 },
					);
				}
				return sessionRecordsToSseResponse(
					(async function* () {
						yield {
							seqNum: 2,
							timestamp: "2026-04-27T00:00:00.000Z",
							event: {
								kind: "chunk",
								runId: "run-1",
								chunk: {
									type: "TEXT_MESSAGE_CONTENT",
									messageId: "m1",
									delta: "hello",
								},
								timestamp: "2026-04-27T00:00:00.000Z",
							},
						} satisfies S2SessionRecord;
						yield {
							seqNum: 3,
							timestamp: "2026-04-27T00:00:00.000Z",
							event: {
								kind: "run-finish",
								runId: "run-1",
								timestamp: "2026-04-27T00:00:00.000Z",
							},
						} satisfies S2SessionRecord;
					})(),
				);
			},
		});

		const parsed: StreamChunk[] = [];
		for await (const chunk of connection.connect([
			{ role: "user", content: "hello" },
		])) {
			parsed.push(chunk);
		}

		expect(parsed).toEqual([
			{ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "hello" },
		]);
		expect(requests).toHaveLength(2);
		expect(requests[0]!.input).toBe("/api/chat/append");
		expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
			messages: [{ role: "user", content: "hello" }],
			streamName: "session-1",
		});
		expect(requests[1]!.input).toBe(
			"/api/chat/tail?transport=s2&streamName=session-1&fromSeqNum=2&live=true",
		);
	});

	it("rejects malformed S2 append responses before tailing", async () => {
		const requests: Array<{ input: string; init?: RequestInit }> = [];
		const connection = createS2Connection({
			appendUrl: "/api/chat/append",
			tailUrl: "/api/chat/tail",
			streamName: "session-1",
			fetchClient: async (input, init) => {
				requests.push({ input: String(input), init });
				return Response.json({ streamName: "session-1", runId: "run-1" });
			},
		});

		await expect(async () => {
			for await (const chunk of connection.connect([
				{ role: "user", content: "hello" },
			])) {
				throw new Error(`Unexpected chunk: ${chunk.type}`);
			}
		}).rejects.toThrow("append response");
		expect(requests).toHaveLength(1);
	});

	it("records a run-error if session production fails before streaming", async () => {
		const stream = new FakeSessionStream();
		const handler = createS2SessionHandler({
			accessToken: "test-token",
			basin: "test-basin",
			getStream: () => stream as any,
			onError: () => "model unavailable",
			async produce() {
				throw new Error("boom");
			},
		});

		const response = await handler.POST(
			new Request("https://example.test/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					streamName: "session-1",
					messages: [{ role: "user", content: "hello" }],
				}),
			}),
		);

		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({
			streamName: "session-1",
			nextSeqNum: 2,
		});

		const snapshot = await handler.snapshot("session-1");
		expect(snapshot.events.map(({ event }) => event.kind)).toEqual([
			"message",
			"run-start",
			"run-error",
		]);
		expect(snapshot.events[2]!.event).toMatchObject({
			kind: "run-error",
			error: { message: "model unavailable" },
		});
	});

	it("rejects invalid session message bodies before appending", async () => {
		const stream = new FakeSessionStream();
		const handler = createS2SessionHandler({
			accessToken: "test-token",
			basin: "test-basin",
			getStream: () => stream as any,
			async produce() {
				return chunks();
			},
		});

		const response = await handler.POST(
			new Request("https://example.test/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					streamName: "session-1",
					messages: "not-an-array",
				}),
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.text()).toBe("messages must be an array");
		expect(stream.records).toHaveLength(0);
	});

	it("batches S2 session chunks before persisting", async () => {
		const stream = new FakeSessionStream();
		let persistPromise: Promise<unknown> | undefined;
		const handler = createS2SessionHandler({
			accessToken: "test-token",
			basin: "test-basin",
			getStream: () => stream as any,
			batchSize: 2,
			lingerDuration: 1000,
			async produce() {
				return textChunks("a", "b", "c");
			},
		});

		const response = await handler.POST(
			new Request("https://example.test/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					streamName: "session-1",
					messages: [{ role: "user", content: "hello" }],
				}),
			}),
			{
				waitUntil(promise) {
					persistPromise = promise;
				},
			},
		);

		expect(response.status).toBe(202);
		expect(persistPromise).toBeDefined();
		await persistPromise;
		expect(stream.appended.map((input) => input.records.length)).toEqual([
			2, 2, 2,
		]);
		expect(
			(await handler.snapshot("session-1")).events.map((r) => r.event.kind),
		).toEqual([
			"message",
			"run-start",
			"chunk",
			"chunk",
			"chunk",
			"run-finish",
		]);
	});

	it("materializes a session snapshot with messages and the next seqNum", async () => {
		const stream = new FakeSessionStream([
			sessionRecord(0, {
				kind: "message",
				message: { role: "user", content: "hello" },
				timestamp: "2026-04-27T00:00:00.000Z",
			}),
			sessionRecord(1, {
				kind: "chunk",
				runId: "run-1",
				chunk: {
					type: "TEXT_MESSAGE_START",
					messageId: "m1",
					role: "assistant",
				},
				timestamp: "2026-04-27T00:00:00.000Z",
			}),
			sessionRecord(2, {
				kind: "chunk",
				runId: "run-1",
				chunk: {
					type: "TEXT_MESSAGE_CONTENT",
					messageId: "m1",
					delta: "hi",
				},
				timestamp: "2026-04-27T00:00:00.000Z",
			}),
		]);

		const snapshot = await materializeSessionSnapshot({
			stream: stream as any,
		});

		expect(snapshot.nextSeqNum).toBe(3);
		expect(snapshot.messages).toEqual([
			{ role: "user", content: "hello" },
			{ id: "m1", role: "assistant", content: "hi" },
		]);
	});
});
