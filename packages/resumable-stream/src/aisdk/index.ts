import { UI_MESSAGE_STREAM_HEADERS, type UIMessageChunk } from "ai";
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

export type Chunk = UIMessageChunk;
export type ResumableChat = Chat<Chunk>;

const adapter: ChatAdapter<Chunk> = {
	makeErrorChunk(err, onError) {
		return {
			type: "error",
			errorText: onError ? onError(err) : DEFAULT_ERROR_TEXT,
		} satisfies UIMessageChunk;
	},
	responseHeaders: UI_MESSAGE_STREAM_HEADERS,
};

/** Persists AI SDK UI message chunks to S2 and replays them. */
export function createResumableChat(
	config: ResumableChatConfig,
): ResumableChat {
	return createChat(config, adapter);
}
