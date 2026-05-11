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
import { type Chunk } from "./accumulator.js";
import {
	createHistorySnapshot,
	emptyHistorySnapshot,
	type HistorySnapshot,
	type StoredHistoryRecord,
} from "./history.js";

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

export type { HistoryError, HistorySnapshot, HistoryTurn } from "./history.js";

export type ResumableChat = Chat<Chunk> & {
	/**
	 * One-shot snapshot of ordered turns and closed assistant messages.
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

/**
 * `nextSeqNum` is the cursor a client should tail from to see anything not
 * already returned in history.
 */
async function readHistoryMessages(
	s2: S2,
	basin: string,
	streamName: string,
): Promise<HistorySnapshot> {
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
		if (!session) return emptyHistorySnapshot();

		const records: StoredHistoryRecord[] = [];

		try {
			for await (const record of session) {
				const fence = isFenceRecord(record);
				records.push({
					seqNum: record.seqNum,
					body: record.body,
					fence,
					terminalFence: fence && isTerminalFence(record),
					trim: isTrimRecord(record),
				});
			}
		} finally {
			await session[Symbol.asyncDispose]?.();
		}

		return createHistorySnapshot(records);
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
			const snapshot = await readHistoryMessages(s2, config.basin, streamName);
			return Response.json(snapshot, {
				headers: { "Cache-Control": "no-store" },
			});
		},
	};
}
