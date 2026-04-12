import type { UIMessage, UIMessageChunk } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createS2Transport } from "../aisdk.js";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
	});
}

function ndjsonResponse(chunks: UIMessageChunk[]): Response {
	return new Response(chunks.map((chunk) => JSON.stringify(chunk)).join("\n"), {
		headers: { "Content-Type": "application/x-ndjson" },
	});
}

function textResponse(body: string, contentType = "text/plain"): Response {
	return new Response(body, {
		headers: { "Content-Type": contentType },
	});
}

async function readAllChunks(
	stream: ReadableStream<UIMessageChunk>,
): Promise<UIMessageChunk[]> {
	const reader = stream.getReader();
	const chunks: UIMessageChunk[] = [];

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	return chunks;
}

describe("createS2Transport", () => {
	it("replays by chat id when sending messages", async () => {
		const fetchClient = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ fromSeqNum: 17 }))
			.mockResolvedValueOnce(
				ndjsonResponse([
					{ type: "start" },
					{ type: "text-start", id: "text-1" },
					{ type: "text-delta", id: "text-1", delta: "hello" },
					{ type: "text-end", id: "text-1" },
					{ type: "finish", finishReason: "stop" },
				]),
			);

		const transport = createS2Transport({
			api: "/api/chat",
			fetchClient,
		});

		const stream = await transport.sendMessages({
			trigger: "submit-message",
			chatId: "chat-1",
			messageId: undefined,
			messages: [] as UIMessage[],
			abortSignal: undefined,
		});

		expect(fetchClient).toHaveBeenNthCalledWith(
			1,
			"/api/chat",
			expect.objectContaining({ method: "POST" }),
		);
		expect(fetchClient).toHaveBeenNthCalledWith(
			2,
			"/api/chat/stream?id=chat-1&from=17",
			expect.objectContaining({ method: "GET" }),
		);

		const chunks = await readAllChunks(stream);
		expect(chunks).toEqual([
			{ type: "start" },
			{ type: "text-start", id: "text-1" },
			{ type: "text-delta", id: "text-1", delta: "hello" },
			{ type: "text-end", id: "text-1" },
			{ type: "finish", finishReason: "stop" },
		]);
	});

	it("reconnects by chat id", async () => {
		const fetchClient = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				ndjsonResponse([
					{ type: "start" },
					{ type: "finish", finishReason: "stop" },
				]),
			);

		const transport = createS2Transport({
			api: "/api/chat",
			reconnectApi: "/api/replay",
			fetchClient,
		});

		const stream = await transport.reconnectToStream({ chatId: "chat-2" });

		expect(fetchClient).toHaveBeenCalledTimes(1);
		expect(fetchClient).toHaveBeenCalledWith(
			"/api/replay?id=chat-2",
			expect.objectContaining({ method: "GET" }),
		);
		expect(await readAllChunks(stream!)).toEqual([
			{ type: "start" },
			{ type: "finish", finishReason: "stop" },
		]);
	});

	it("requires reconnectApi when api contains a query string", async () => {
		const fetchClient = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ ok: true }));

		const transport = createS2Transport({
			api: "/api/chat?foo=1",
			fetchClient,
		});

		await expect(
			transport.sendMessages({
				trigger: "submit-message",
				chatId: "chat-params",
				messageId: undefined,
				messages: [] as UIMessage[],
				abortSignal: undefined,
			}),
		).rejects.toThrow(
			"[resumable-stream] Pass reconnectApi explicitly when api contains a query string or hash.",
		);
		expect(fetchClient).toHaveBeenCalledTimes(1);
	});

	it("appends chat id to reconnectApi with existing query params", async () => {
		const fetchClient = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ fromSeqNum: 29 }))
			.mockResolvedValueOnce(
				ndjsonResponse([
					{ type: "start" },
					{ type: "finish", finishReason: "stop" },
				]),
			);

		const transport = createS2Transport({
			api: "/api/chat?foo=1",
			reconnectApi: "/api/replay?foo=1",
			fetchClient,
		});

		const stream = await transport.sendMessages({
			trigger: "submit-message",
			chatId: "chat-params",
			messageId: undefined,
			messages: [] as UIMessage[],
			abortSignal: undefined,
		});

		expect(fetchClient).toHaveBeenNthCalledWith(
			2,
			"/api/replay?foo=1&id=chat-params&from=29",
			expect.objectContaining({ method: "GET" }),
		);
		expect(await readAllChunks(stream)).toEqual([
			{ type: "start" },
			{ type: "finish", finishReason: "stop" },
		]);
	});

	it("falls back to active-only replay when durability metadata is missing", async () => {
		const fetchClient = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ ok: true }))
			.mockResolvedValueOnce(
				ndjsonResponse([
					{ type: "start" },
					{ type: "finish", finishReason: "stop" },
				]),
			);

		const transport = createS2Transport({
			api: "/api/chat",
			fetchClient,
		});

		const stream = await transport.sendMessages({
			trigger: "submit-message",
			chatId: "chat-fallback",
			messageId: undefined,
			messages: [] as UIMessage[],
			abortSignal: undefined,
		});

		expect(fetchClient).toHaveBeenNthCalledWith(
			2,
			"/api/chat/stream?id=chat-fallback",
			expect.objectContaining({ method: "GET" }),
		);
		expect(await readAllChunks(stream)).toEqual([
			{ type: "start" },
			{ type: "finish", finishReason: "stop" },
		]);
	});

	it("returns null on reconnect when there is no active generation", async () => {
		const fetchClient = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 204 }));

		const transport = createS2Transport({
			api: "/api/chat",
			fetchClient,
		});

		await expect(
			transport.reconnectToStream({ chatId: "chat-idle" }),
		).resolves.toBeNull();
	});

	it("fails on malformed NDJSON replay data", async () => {
		const fetchClient = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ ok: true }))
			.mockResolvedValueOnce(
				textResponse(
					`${JSON.stringify({ type: "start" } satisfies UIMessageChunk)}\nnot-json\n`,
					"application/x-ndjson",
				),
			);

		const transport = createS2Transport({
			api: "/api/chat",
			fetchClient,
		});

		const stream = await transport.sendMessages({
			trigger: "submit-message",
			chatId: "chat-bad",
			messageId: undefined,
			messages: [] as UIMessage[],
			abortSignal: undefined,
		});

		await expect(readAllChunks(stream)).rejects.toThrow(
			"[resumable-stream] Invalid NDJSON chunk: not-json",
		);
	});
});
