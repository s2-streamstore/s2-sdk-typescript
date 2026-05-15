import {
	type Chat,
	type ChatAdapter,
	createChat,
	DEFAULT_ERROR_TEXT,
	type ResumableChatConfig,
} from "../adapter.js";

export type {
	MakeResumableOptions,
	ReplayOptions,
	ResumableChatConfig,
	ResumableChatMode,
} from "../adapter.js";

/** Structural shape that matches `@tanstack/ai`'s `StreamChunk`. */
export type Chunk = {
	type: string;
	timestamp?: number;
	[key: string]: unknown;
};

export type ResumableChat = Chat<Chunk>;

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
	responseHeaders: SSE_HEADERS,
};

/** Persists TanStack AI stream chunks to S2 and replays them as SSE. */
export function createResumableChat(
	config: ResumableChatConfig,
): ResumableChat {
	return createChat(config, adapter);
}
