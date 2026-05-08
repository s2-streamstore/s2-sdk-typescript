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
import { createAnthropicAccumulator } from "./anthropic-accumulator.js";
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
	accumulateMessage,
	createAnthropicAccumulator,
} from "./anthropic-accumulator.js";

/**
 * Anthropic chat chunk: the union of `RawMessageStreamEvent` plus the
 * `error` event that Anthropic emits at the SSE wire level (its `error`
 * event is not a member of `RawMessageStreamEvent`).
 */
export type AnthropicChunk =
	| RawMessageStreamEvent
	| {
			type: "error";
			error: { type: string; message: string };
	  };

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

async function readHistoryMessages(
	s2: S2,
	basin: string,
	streamName: string,
): Promise<{ messages: Message[]; nextSeqNum: number }> {
	const handle = s2.basin(basin).stream(streamName);
	try {
		// Walk all records (including command records). We need the seqNum of
		// the most recent record so callers can tail from `nextSeqNum` without
		// re-receiving the events already returned in `messages`.
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
		// `nextSeqNum` is the cursor a client should tail from to see anything
		// not already in `messages`. That means: start of the in-flight turn
		// if one exists, otherwise the tail of the stream.
		//
		// We track it as "seq right after the most recent terminal fence". If
		// no terminal fence has been seen yet, the in-flight turn (if any)
		// starts at seq 0, so cursor stays at 0. After every closed turn
		// (which always ends with a terminal fence), we advance the cursor
		// past that fence — so a tail from there picks up any subsequent
		// in-flight turn from its opening fence onward, and any new turn that
		// starts later.
		let nextSeqNum = 0;

		try {
			for await (const record of session) {
				if (isFenceRecord(record)) {
					if (isTerminalFence(record)) {
						nextSeqNum = record.seqNum + 1;
					}
					continue;
				}
				if (isTrimRecord(record)) continue;
				if (!record.body) continue;
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
