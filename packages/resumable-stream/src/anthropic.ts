/**
 * Server-side helpers for making Anthropic SDK streams resumable in S2.
 *
 * Wire format on both the live response and replay is Anthropic-native SSE:
 *
 *   event: <event_type>
 *   data: <json>
 *   id: <seq>
 *
 * which is what `client.messages.stream(...)` produces, so a vanilla SSE
 * parser sees the same bytes regardless of whether the source is a fresh
 * Anthropic API call or our replay endpoint.
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
} from "./adapter.js";
import {
	type AnthropicChunk,
	createAnthropicAccumulator,
} from "./anthropic-accumulator.js";
import { isFenceRecord, isTerminalFence, isTrimRecord } from "./protocol.js";
import { isMissingStreamError } from "./shared.js";

export type {
	MakeResumableOptions,
	ReplayOptions,
	ResumableChatConfig,
	ResumableChatMode,
} from "./adapter.js";

export {
	type AnthropicAccumulator,
	type AnthropicChunk,
	accumulateMessage,
	createAnthropicAccumulator,
	messagesFromEvents,
} from "./anthropic-accumulator.js";

export type ResumableChat = Chat<AnthropicChunk> & {
	/**
	 * One-shot snapshot of closed turns as `Message[]`, in turn order.
	 * Excludes any in-flight turn that hasn't yet emitted `message_stop`.
	 */
	history(streamName: string): Promise<Response>;
};

const SSE_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache",
	Connection: "keep-alive",
	"X-Accel-Buffering": "no",
} as const;

const adapter: ChatAdapter<AnthropicChunk> = {
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

/**
 * `nextSeqNum` is the cursor a client should tail from to see anything not
 * already in `messages`: the seq right after the most recent terminal fence,
 * or 0 if no turn has closed yet. A tail from there picks up an in-flight
 * turn from its opening fence onward (or sits idle until a new turn starts).
 */
async function readHistoryMessages(
	s2: S2,
	basin: string,
	streamName: string,
): Promise<{ messages: Message[]; nextSeqNum: number }> {
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
		if (!session) return { messages: [], nextSeqNum: 0 };

		const messages: Message[] = [];
		const acc = createAnthropicAccumulator();
		let active = false;
		let nextSeqNum = 0;

		try {
			for await (const record of session) {
				if (isFenceRecord(record)) {
					if (isTerminalFence(record)) nextSeqNum = record.seqNum + 1;
					continue;
				}
				if (isTrimRecord(record) || !record.body) continue;
				let event: RawMessageStreamEvent;
				try {
					event = JSON.parse(record.body) as RawMessageStreamEvent;
				} catch {
					continue;
				}
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
				}
			}
		} finally {
			await session[Symbol.asyncDispose]?.();
		}

		return { messages, nextSeqNum };
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
			const { messages, nextSeqNum } = await readHistoryMessages(
				s2,
				config.basin,
				streamName,
			);
			return Response.json(
				{ messages, nextSeqNum },
				{ headers: { "Cache-Control": "no-store" } },
			);
		},
	};
}
