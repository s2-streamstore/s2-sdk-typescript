import {
	type Chat,
	type ChatAdapter,
	createChat,
	DEFAULT_ERROR_TEXT,
	type ResumableChatConfig,
} from "../adapter.js";
import type { Chunk } from "./types.js";

export type {
	MakeResumableOptions,
	ReplayOptions,
	ResumableChatConfig,
	ResumableChatMode,
	ResumableSource,
} from "../adapter.js";
export type { Chunk } from "./types.js";

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
			type: "error",
			error: { type: "api_error", message },
		};
	},
	makeStopChunk: () => ({ type: "message_stop" }),
	responseHeaders: SSE_HEADERS,
	formatSseFrame(storedBody) {
		try {
			const parsed = JSON.parse(storedBody) as { type?: string };
			return parsed.type
				? { event: parsed.type, data: storedBody }
				: { data: storedBody };
		} catch {
			return { data: storedBody };
		}
	},
};

/** Persists `client.messages.stream(...)` events to S2 and replays them as Anthropic-shaped SSE. */
export function createResumableChat(
	config: ResumableChatConfig,
): ResumableChat {
	return createChat(config, adapter);
}
