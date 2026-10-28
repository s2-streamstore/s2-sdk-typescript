import type { S2Stream } from "@s2-dev/streamstore";
import {
	type Chat,
	type ChatAdapter,
	createChat,
	DEFAULT_ERROR_TEXT,
	type ResumableChatConfig,
} from "../adapter.js";
import { readAvailableDataRecords } from "../shared.js";

export type {
	MakeResumableOptions,
	ReplayOptions,
	ResumableChatConfig,
	ResumableChatMode,
	ResumableSource,
} from "../adapter.js";

/** Structural shape that matches `@tanstack/ai`'s `StreamChunk`. */
export type Chunk = {
	type: string;
	timestamp?: number;
	[key: string]: unknown;
};

export type ResumableChat = Chat<Chunk>;

/**
 * Reads the chunks currently stored in a stream without waiting for new data.
 * Reassembles multipart chunks; each cursor follows a complete chunk, so a
 * later replay can resume safely. The caller owns and closes `stream`.
 */
export async function* readStoredChunks(
	stream: S2Stream,
	fromSeqNum = 0,
): AsyncIterable<{ chunk: Chunk; nextSeqNum: number }> {
	for await (const { body, nextSeqNum } of readAvailableDataRecords(
		stream,
		fromSeqNum,
	)) {
		yield { chunk: JSON.parse(body) as Chunk, nextSeqNum };
	}
}

const SSE_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache",
	Connection: "keep-alive",
	"X-Accel-Buffering": "no",
} as const;

const adapter: ChatAdapter<Chunk> = {
	makeErrorChunk(err, onError) {
		const message = onError ? onError(err) : DEFAULT_ERROR_TEXT;
		return {
			type: "RUN_ERROR",
			timestamp: Date.now(),
			message,
			error: { message },
		};
	},
	async stopChunks(chunks) {
		const active = new Map<string, unknown>();
		for await (const chunk of chunks) {
			if (chunk.type === "RUN_STARTED" && typeof chunk.runId === "string") {
				active.set(chunk.runId, chunk.threadId);
			} else if (chunk.type === "RUN_FINISHED" || chunk.type === "RUN_ERROR") {
				if (typeof chunk.runId === "string") active.delete(chunk.runId);
				else if (chunk.type === "RUN_ERROR") active.clear();
			}
		}
		// A stop before RUN_STARTED must still release a pending client send.
		if (active.size === 0) active.set(`s2-stop-${Date.now()}`, "s2-stop");
		return [...active].map(([runId, threadId]) => ({
			type: "RUN_FINISHED",
			threadId,
			runId,
			timestamp: Date.now(),
			finishReason: "stop",
		}));
	},
	responseHeaders: SSE_HEADERS,
};

/** Persists TanStack AI stream chunks to S2 and replays them as SSE. */
export function createResumableChat(
	config: ResumableChatConfig,
): ResumableChat {
	return createChat(config, adapter);
}
