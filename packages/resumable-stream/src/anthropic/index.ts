/**
 * Server-side helpers for making Anthropic SDK streams resumable in S2.
 *
 * Assistant events use Anthropic-native SSE:
 *
 *   event: <event_type>
 *   data: <json>
 *   id: <seq>
 *
 * which is what `client.messages.stream(...)` produces. Apps can also store
 * `{ type: "user_message", message }` records in the same session stream so
 * history has both sides of the chat.
 */
import type {
	Message,
	RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import { S2 } from "@s2-dev/streamstore";
import {
	type Chat,
	type ChatAdapter,
	createChat,
	DEFAULT_ERROR_TEXT,
	type ResumableChatConfig,
} from "../adapter.js";
import { isFenceRecord, isTerminalFence, isTrimRecord } from "../protocol.js";
import { isMissingStreamError } from "../shared.js";
import { type Chunk, createAccumulator } from "./accumulator.js";

export type {
	MakeResumableOptions,
	ReplayOptions,
	ResumableChatConfig,
	ResumableChatMode,
} from "../adapter.js";

export {
	type Accumulator,
	accumulateMessage,
	type Chunk,
	createAccumulator,
	messagesFromEvents,
} from "./accumulator.js";

export type ResumableChat = Chat<Chunk> & {
	/**
	 * One-shot snapshot of user messages and closed assistant turns.
	 * Excludes any assistant turn that hasn't yet emitted `message_stop`.
	 */
	history(streamName: string): Promise<Response>;
};

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

const RAW_MESSAGE_EVENT_TYPES = new Set<RawMessageStreamEvent["type"]>([
	"message_start",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
	"message_delta",
	"message_stop",
]);

function isMessageEvent(event: Chunk): event is RawMessageStreamEvent {
	return RAW_MESSAGE_EVENT_TYPES.has(
		event.type as RawMessageStreamEvent["type"],
	);
}

/**
 * `nextSeqNum` is the cursor a client should tail from to see anything not
 * already returned in history.
 */
async function readHistoryMessages(
	s2: S2,
	basin: string,
	streamName: string,
): Promise<{ users: string[]; messages: Message[]; nextSeqNum: number }> {
	const handle = s2.basin(basin).stream(streamName);
	try {
		const session = await handle
			.readSession(
				{
					start: { from: { seqNum: 0 }, clamp: true },
					stop: { waitSecs: 0 },
				},
				{ as: "string" },
			)
			.catch((error: unknown) => {
				if (isMissingStreamError(error)) return null;
				throw error;
			});
		if (!session) return { users: [], messages: [], nextSeqNum: 0 };

		const users: string[] = [];
		const messages: Message[] = [];
		const acc = createAccumulator();
		let active = false;
		let nextSeqNum = 0;

		try {
			for await (const record of session) {
				if (isFenceRecord(record)) {
					if (isTerminalFence(record)) nextSeqNum = record.seqNum + 1;
					continue;
				}
				if (isTrimRecord(record) || !record.body) continue;
				let event: Chunk;
				try {
					event = JSON.parse(record.body) as Chunk;
				} catch {
					continue;
				}
				if (
					event.type === "user_message" &&
					typeof event.message === "string"
				) {
					users.push(event.message);
					nextSeqNum = record.seqNum + 1;
					continue;
				}
				if (!isMessageEvent(event)) continue;
				if (event.type === "message_start") {
					acc.reset();
					acc.push(event);
					active = true;
					continue;
				}
				if (!active) continue;
				acc.push(event);
				if (event.type === "message_stop") {
					messages.push(acc.finalMessage());
					acc.reset();
					active = false;
					nextSeqNum = record.seqNum + 1;
				}
			}
		} finally {
			await session[Symbol.asyncDispose]?.();
		}

		return { users, messages, nextSeqNum };
	} finally {
		await handle.close();
	}
}

/**
 * Creates server-side helpers for making Anthropic SDK streams resumable in S2.
 */
export function createResumableChat(
	config: ResumableChatConfig,
): ResumableChat {
	const base = createChat(config, adapter);
	const s2 = new S2({
		accessToken: config.accessToken,
		endpoints: config.endpoints,
	});

	return {
		...base,
		async history(streamName: string): Promise<Response> {
			const { users, messages, nextSeqNum } = await readHistoryMessages(
				s2,
				config.basin,
				streamName,
			);
			return Response.json(
				{ users, messages, nextSeqNum },
				{ headers: { "Cache-Control": "no-store" } },
			);
		},
	};
}
