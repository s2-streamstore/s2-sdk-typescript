import type { StreamChunk, UIMessage } from "@tanstack/ai";
import type {
	ConnectConnectionAdapter,
	SubscribeConnectionAdapter,
} from "@tanstack/ai-client";
import { describe, expect, it } from "vitest";
import { createS2Connection, loadSnapshot } from "../tanstack-ai-client.js";

function sseResponse(frames: string[], status = 200): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const frame of frames) {
				controller.enqueue(encoder.encode(frame));
			}
			controller.close();
		},
	});
	return new Response(body, {
		status,
		headers: { "Content-Type": "text/event-stream" },
	});
}

function frame(chunk: object): string {
	return `data: ${JSON.stringify(chunk)}\n\n`;
}

function frameWithId(id: number, chunk: object): string {
	return `id: ${id}\ndata: ${JSON.stringify(chunk)}\n\n`;
}

function hangingSseResponse(): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(frame({ type: "RUN_STARTED" })));
			},
		}),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}

interface CapturedRequest {
	url: string;
	init: RequestInit;
}

function recordingFetch(responses: Response[]): {
	fetch: typeof fetch;
	calls: CapturedRequest[];
} {
	const calls: CapturedRequest[] = [];
	const queue = [...responses];
	const fakeFetch: typeof fetch = async (input, init = {}) => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push({ url, init });
		const next = queue.shift();
		if (!next) throw new Error(`fetch called more times than expected: ${url}`);
		return next;
	};
	return { fetch: fakeFetch, calls };
}

async function drainAsyncIterable<T>(source: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const value of source) out.push(value);
	return out;
}

const messages: UIMessage[] = [
	{
		id: "u1",
		role: "user",
		parts: [{ type: "text", content: "hi" }],
	},
];

describe("createS2Connection (single-use / shared)", () => {
	it("POSTs to sendUrl and yields parsed chunks from the SSE response", async () => {
		const { fetch, calls } = recordingFetch([
			sseResponse([
				frame({ type: "RUN_STARTED", timestamp: 1 }),
				frame({
					type: "TEXT_MESSAGE_CONTENT",
					timestamp: 2,
					messageId: "m1",
					delta: "hi",
				}),
				frame({ type: "RUN_FINISHED", timestamp: 3 }),
			]),
		]);

		const adapter = createS2Connection({
			sendUrl: "/api/chat",
			fetch,
		}) as ConnectConnectionAdapter;

		const chunks = await drainAsyncIterable(adapter.connect(messages));
		expect(chunks.map((c) => c.type)).toEqual([
			"RUN_STARTED",
			"TEXT_MESSAGE_CONTENT",
			"RUN_FINISHED",
		]);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("/api/chat");
		expect(calls[0]!.init.method).toBe("POST");
		const body = JSON.parse(calls[0]!.init.body as string) as {
			messages: UIMessage[];
		};
		expect(body.messages).toEqual(messages);
	});

	it("yields RUN_ERROR chunks verbatim instead of throwing", async () => {
		const { fetch } = recordingFetch([
			sseResponse([
				frame({ type: "RUN_STARTED", timestamp: 1 }),
				frame({
					type: "RUN_ERROR",
					timestamp: 2,
					error: { message: "model exploded" },
				}),
			]),
		]);

		const adapter = createS2Connection({
			sendUrl: "/api/chat",
			fetch,
		}) as ConnectConnectionAdapter;

		const chunks = await drainAsyncIterable(adapter.connect(messages));
		expect(chunks.at(-1)).toMatchObject({
			type: "RUN_ERROR",
			error: { message: "model exploded" },
		});
	});

	it("skips malformed JSON frames and keeps yielding valid ones", async () => {
		const { fetch } = recordingFetch([
			sseResponse([
				frame({ type: "RUN_STARTED" }),
				"data: {not json\n\n",
				frame({ type: "RUN_FINISHED" }),
			]),
		]);

		const adapter = createS2Connection({
			sendUrl: "/api/chat",
			fetch,
		}) as ConnectConnectionAdapter;

		const chunks = await drainAsyncIterable(adapter.connect(messages));
		expect(chunks.map((c) => c.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
	});

	it("treats a `data: [DONE]` line as a no-op for forward compatibility", async () => {
		const { fetch } = recordingFetch([
			sseResponse([
				frame({ type: "RUN_STARTED" }),
				"data: [DONE]\n\n",
				frame({ type: "RUN_FINISHED" }),
			]),
		]);

		const adapter = createS2Connection({
			sendUrl: "/api/chat",
			fetch,
		}) as ConnectConnectionAdapter;

		const chunks = await drainAsyncIterable(adapter.connect(messages));
		expect(chunks.map((c) => c.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
	});

	it("merges custom body fields into the POST payload", async () => {
		const { fetch, calls } = recordingFetch([sseResponse([])]);

		const adapter = createS2Connection({
			sendUrl: "/api/chat",
			body: { id: "chat-123" },
			fetch,
		}) as ConnectConnectionAdapter;

		await drainAsyncIterable(adapter.connect(messages));
		const body = JSON.parse(calls[0]!.init.body as string) as {
			id: string;
			messages: UIMessage[];
		};
		expect(body.id).toBe("chat-123");
		expect(body.messages).toEqual(messages);
	});

	it("throws on non-2xx HTTP responses", async () => {
		const { fetch } = recordingFetch([sseResponse([], 503)]);

		const adapter = createS2Connection({
			sendUrl: "/api/chat",
			fetch,
		}) as ConnectConnectionAdapter;

		await expect(drainAsyncIterable(adapter.connect(messages))).rejects.toThrow(
			/HTTP 503/,
		);
	});

	it("threads abortSignal through to fetch", async () => {
		const { fetch, calls } = recordingFetch([sseResponse([])]);
		const ctrl = new AbortController();
		const adapter = createS2Connection({
			sendUrl: "/api/chat",
			fetch,
		}) as ConnectConnectionAdapter;

		await drainAsyncIterable(adapter.connect(messages, undefined, ctrl.signal));
		expect(calls[0]!.init.signal).toBe(ctrl.signal);
	});
});

describe("createS2Connection (shared-live)", () => {
	it("requires subscribeUrl at construction", () => {
		expect(() =>
			createS2Connection({ sendUrl: "/api/chat", mode: "shared-live" }),
		).toThrow(/subscribeUrl is required/);
	});

	it("subscribe() GETs subscribeUrl and yields chunks; send() POSTs to sendUrl", async () => {
		const { fetch, calls } = recordingFetch([
			sseResponse([
				frame({ type: "RUN_STARTED", timestamp: 1 }),
				frame({ type: "RUN_FINISHED", timestamp: 2 }),
			]),
			hangingSseResponse(),
		]);

		const adapter = createS2Connection({
			sendUrl: "/api/chat",
			subscribeUrl: "/api/chat/replay",
			mode: "shared-live",
			fetch,
		}) as SubscribeConnectionAdapter;

		const chunks: StreamChunk[] = [];
		const subscriber = (async () => {
			for await (const chunk of adapter.subscribe()) chunks.push(chunk);
		})();
		await subscriber;
		await adapter.send(messages);

		expect(calls[0]!.url).toBe("/api/chat/replay");
		expect(calls[0]!.init.method).toBe("GET");
		expect(calls[1]!.url).toBe("/api/chat");
		expect(calls[1]!.init.method).toBe("POST");
		expect(chunks.map((c) => c.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
	});

	it("uses snapshot cursor for subscribe() and advances it from SSE ids", async () => {
		const { fetch, calls } = recordingFetch([
			sseResponse([
				frameWithId(6, { type: "RUN_STARTED", timestamp: 1 }),
				frameWithId(9, { type: "RUN_FINISHED", timestamp: 2 }),
			]),
			sseResponse([]),
		]);

		const adapter = createS2Connection({
			sendUrl: "/api/chat",
			subscribeUrl: "/api/chat/replay?id=chat-1",
			mode: "shared-live",
			snapshot: { messages, fromSeqNum: 5 },
			fetch,
		}) as SubscribeConnectionAdapter;

		await drainAsyncIterable(adapter.subscribe());
		await drainAsyncIterable(adapter.subscribe());

		expect(calls[0]!.url).toBe("/api/chat/replay?id=chat-1&from=5");
		expect(calls[1]!.url).toBe("/api/chat/replay?id=chat-1&from=9");
	});

	it("loads a shared-live snapshot response", async () => {
		const { fetch, calls } = recordingFetch([
			new Response(JSON.stringify({ messages, fromSeqNum: 12 }), {
				headers: { "Content-Type": "application/json" },
			}),
		]);

		const snapshot = await loadSnapshot({
			url: "/api/chat/snapshot?id=chat-1",
			fetch,
		});

		expect(snapshot).toEqual({ messages, fromSeqNum: 12 });
		expect(calls[0]!.url).toBe("/api/chat/snapshot?id=chat-1");
		expect(calls[0]!.init.method).toBe("GET");
	});
});
