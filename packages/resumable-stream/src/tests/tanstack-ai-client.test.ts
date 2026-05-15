import type { StreamChunk } from "@tanstack/ai";
import { describe, expect, it } from "vitest";
import { createConnection } from "../tanstack-ai/client.js";

function sseResponse(frames: string[], status = 200): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const frame of frames) controller.enqueue(encoder.encode(frame));
			controller.close();
		},
	});
	return new Response(body, {
		status,
		headers: { "Content-Type": "text/event-stream" },
	});
}

function chunkFrame(chunk: StreamChunk, id?: number): string {
	const lines = [`event: ${chunk.type}`];
	if (id !== undefined) lines.push(`id: ${id}`);
	lines.push(`data: ${JSON.stringify(chunk)}`);
	return `${lines.join("\n")}\n\n`;
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

async function drain(
	iterable: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> {
	const out: StreamChunk[] = [];
	for await (const chunk of iterable) out.push(chunk);
	return out;
}

describe("createConnection", () => {
	it("subscribe() GETs subscribeUrl and yields parsed chunks", async () => {
		const chunks: StreamChunk[] = [
			{ type: "RUN_STARTED", runId: "r1", timestamp: 1 },
			{
				type: "TEXT_MESSAGE_CONTENT",
				messageId: "m1",
				delta: "hi",
				timestamp: 2,
			},
			{ type: "RUN_FINISHED", runId: "r1", timestamp: 3 },
		];
		const { fetch, calls } = recordingFetch([
			sseResponse(chunks.map((c, i) => chunkFrame(c, i + 1))),
		]);

		const connection = createConnection({
			sendUrl: "/api/chat",
			subscribeUrl: "/api/chat/stream",
			fetch,
		});

		const collected = await drain(connection.subscribe());

		expect(collected).toEqual(chunks);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("/api/chat/stream");
		expect(calls[0]!.init.method).toBe("GET");
	});

	it("send() POSTs { messages, data } and additional body fields", async () => {
		const { fetch, calls } = recordingFetch([
			new Response(null, { status: 202 }),
		]);
		const connection = createConnection({
			sendUrl: "/api/chat",
			subscribeUrl: "/api/chat/stream",
			fetch,
			body: { trace: "abc" },
		});

		await connection.send(
			[{ id: "u1", role: "user", parts: [{ type: "text", content: "hi" }] }],
			{ extra: 1 },
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("/api/chat");
		expect(calls[0]!.init.method).toBe("POST");
		expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
			messages: [
				{ id: "u1", role: "user", parts: [{ type: "text", content: "hi" }] },
			],
			data: { extra: 1 },
			trace: "abc",
		});
	});

	it("body factory receives messages and data", async () => {
		const { fetch, calls } = recordingFetch([
			new Response(null, { status: 202 }),
		]);
		const seen: unknown[] = [];
		const connection = createConnection({
			sendUrl: "/api/chat",
			subscribeUrl: "/api/chat/stream",
			fetch,
			body: (messages, data) => {
				seen.push({ messages, data });
				return { runId: "r" };
			},
		});

		await connection.send(
			[{ id: "u1", role: "user", parts: [{ type: "text", content: "hi" }] }],
			{ a: 1 },
		);

		expect(seen).toHaveLength(1);
		const body = JSON.parse(calls[0]!.init.body as string);
		expect(body.runId).toBe("r");
		expect(body.data).toEqual({ a: 1 });
	});

	it("advances the cursor from SSE ids and includes ?from= on the next subscribe", async () => {
		const first = sseResponse([
			chunkFrame({ type: "RUN_STARTED", runId: "r", timestamp: 1 }, 5),
			chunkFrame(
				{ type: "RUN_FINISHED", runId: "r", timestamp: 2 } as StreamChunk,
				7,
			),
		]);
		const second = sseResponse([
			chunkFrame({ type: "RUN_STARTED", runId: "r2", timestamp: 3 }, 8),
		]);
		const { fetch, calls } = recordingFetch([first, second]);
		const connection = createConnection({
			sendUrl: "/api/chat",
			subscribeUrl: "/api/chat/stream",
			fetch,
		});

		await drain(connection.subscribe());
		await drain(connection.subscribe());

		expect(calls[0]!.url).toBe("/api/chat/stream");
		expect(calls[1]!.url).toBe("/api/chat/stream?from=7");
	});

	it("skips malformed JSON frames and keeps yielding valid ones", async () => {
		const valid: StreamChunk = {
			type: "RUN_FINISHED",
			runId: "r",
			timestamp: 1,
		};
		const { fetch } = recordingFetch([
			sseResponse(["event: junk\ndata: not-json\n\n", chunkFrame(valid, 1)]),
		]);
		const connection = createConnection({
			sendUrl: "/api/chat",
			subscribeUrl: "/api/chat/stream",
			fetch,
		});

		const collected = await drain(connection.subscribe());
		expect(collected).toEqual([valid]);
	});

	it("throws on non-2xx HTTP responses from subscribe", async () => {
		const { fetch } = recordingFetch([new Response("nope", { status: 500 })]);
		const connection = createConnection({
			sendUrl: "/api/chat",
			subscribeUrl: "/api/chat/stream",
			fetch,
		});

		await expect(drain(connection.subscribe())).rejects.toThrow();
	});

	it("threads abortSignal through to fetch", async () => {
		const { fetch, calls } = recordingFetch([
			sseResponse([chunkFrame({ type: "RUN_FINISHED", runId: "r" }, 1)]),
		]);
		const connection = createConnection({
			sendUrl: "/api/chat",
			subscribeUrl: "/api/chat/stream",
			fetch,
		});

		const ac = new AbortController();
		await drain(connection.subscribe(ac.signal));
		expect(calls[0]!.init.signal).toBe(ac.signal);
	});
});
