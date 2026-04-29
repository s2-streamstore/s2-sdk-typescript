import { UI_MESSAGE_STREAM_HEADERS, type UIMessageChunk } from "ai";
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
	ResumableChatMode,
} from "./adapter.js";

/**
 * Server-side helpers for writing and replaying resumable AI SDK streams.
 */
export type ResumableChat = Chat<UIMessageChunk>;

const adapter: ChatAdapter<UIMessageChunk> = {
	makeErrorChunk(err, onError) {
		return {
			type: "error",
			errorText: onError ? onError(err) : DEFAULT_ERROR_TEXT,
		} satisfies UIMessageChunk;
	},
	responseHeaders: UI_MESSAGE_STREAM_HEADERS,
};

/**
 * Creates server-side helpers for making AI SDK streams resumable in S2.
 */
export function createResumableChat(
	config: ResumableChatConfig,
): ResumableChat {
	return createChat(config, adapter);
}
