import type { UIMessage, UIMessageChunk } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createS2Transport, type StreamStateStore } from "../aisdk.js";

class MemoryStreamStateStore implements StreamStateStore {
	private readonly store = new Map<string, string>();

	get(chatId: string): string | null {
		return this.store.get(chatId) ?? null;
	}

	set(chatId: string, streamName: string): void {
		this.store.set(chatId, streamName);
	}

	delete(chatId: string): void {
		this.store.delete(chatId);
	}
}

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
	it("replays by returned stream id instead of chat id", async () => {
		const fetchClient = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ stream: "stream-123" }))
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
			streamStateStore: new MemoryStreamStateStore(),
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
			"/api/chat/stream?stream=stream-123",
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

	it("reuses the stored stream id when reconnecting", async () => {
		const store = new MemoryStreamStateStore();
		store.set("chat-2", "stream-456");

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
			streamStateStore: store,
		});

		const stream = await transport.reconnectToStream({ chatId: "chat-2" });

		expect(fetchClient).toHaveBeenCalledTimes(1);
		expect(fetchClient).toHaveBeenCalledWith(
			"/api/replay?stream=stream-456",
			expect.objectContaining({ method: "GET" }),
		);
		expect(await readAllChunks(stream!)).toEqual([
			{ type: "start" },
			{ type: "finish", finishReason: "stop" },
		]);
	});

	it("clears the stored stream when a terminal chunk is received", async () => {
		const store = new MemoryStreamStateStore();
		const fetchClient = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ stream: "stream-789" }))
			.mockResolvedValueOnce(
				ndjsonResponse([
					{ type: "start" },
					{ type: "finish", finishReason: "stop" },
				]),
			);

		const transport = createS2Transport({
			api: "/api/chat",
			fetchClient,
			streamStateStore: store,
		});

		const stream = await transport.sendMessages({
			trigger: "submit-message",
			chatId: "chat-3",
			messageId: undefined,
			messages: [] as UIMessage[],
			abortSignal: undefined,
		});

		expect(store.get("chat-3")).toBe("stream-789");
		await readAllChunks(stream);
		expect(store.get("chat-3")).toBeNull();
	});
});
