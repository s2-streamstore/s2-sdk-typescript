import {
	type Chat,
	type ChatAdapter,
	createChat,
	DEFAULT_ERROR_TEXT,
	type ResumableChatConfig,
} from "./adapter.js";

export type {
	MakeResumableOptions,
	ResumableChatConfig,
} from "./adapter.js";

/**
 * Structural version of TanStack AI's `StreamChunk`. Avoids a runtime
 * dependency on `@tanstack/ai`.
 */
export type StreamChunk = {
	type: string;
	timestamp?: number;
	[key: string]: unknown;
};

/**
 * Server-side helpers for writing and replaying resumable TanStack AI streams.
 */
export type ResumableChat = Chat<StreamChunk>;

const SSE_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache",
	Connection: "keep-alive",
	"X-Accel-Buffering": "no",
} as const;

const adapter: ChatAdapter<StreamChunk> = {
	makeErrorChunk(err, onError) {
		return {
			type: "RUN_ERROR",
			timestamp: Date.now(),
			error: { message: onError ? onError(err) : DEFAULT_ERROR_TEXT },
		};
	},
	responseHeaders: SSE_HEADERS,
};

/** Creates server-side helpers for making TanStack AI streams resumable in S2. */
export function createResumableChat(
	config: ResumableChatConfig,
): ResumableChat {
	return createChat(config, adapter);
}
