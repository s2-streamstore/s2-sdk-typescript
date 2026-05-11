import type {
	Message,
	RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import { type Chunk, createAccumulator } from "./accumulator.js";

export interface HistoryError {
	/** Anthropic-style error type, for example `api_error`. */
	type: string;
	/** Error text safe to render in chat history. */
	message: string;
}

export interface HistoryTurn {
	/** User text stored from a `user_message` event. */
	user: string;
	/** Completed assistant message reconstructed from Anthropic stream events. */
	assistant?: Message;
	/** Error recorded for this turn when generation failed before completion. */
	error?: HistoryError;
}

export interface HistorySnapshot {
	/** Ordered chat turns, pairing each stored user message with its result. */
	turns: HistoryTurn[];
	/** Completed assistant messages, useful when an app only needs model output. */
	messages: Message[];
	/** Cursor clients should pass as `fromSeqNum` to continue replaying. */
	nextSeqNum: number;
}

export interface StoredHistoryRecord {
	/** S2 sequence number for the stored record. */
	seqNum: number;
	/** Raw record body, expected to be a JSON Anthropic/user/error event. */
	body?: string;
	/** True when this record is an S2 protocol fence command. */
	fence?: boolean;
	/** True when the fence marks the end of a generation. */
	terminalFence?: boolean;
	/** True when this record is an S2 trim command. */
	trim?: boolean;
}

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

function parseChunk(body: string): Chunk | undefined {
	try {
		return JSON.parse(body) as Chunk;
	} catch {
		return undefined;
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isHistoryError(value: unknown): value is HistoryError {
	return (
		isObject(value) &&
		typeof value.type === "string" &&
		typeof value.message === "string"
	);
}

function isValidCursor(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeTurn(value: unknown): HistoryTurn | undefined {
	if (!isObject(value) || typeof value.user !== "string") return undefined;
	return {
		user: value.user,
		assistant: value.assistant as Message | undefined,
		error: isHistoryError(value.error) ? value.error : undefined,
	};
}

export function emptyHistorySnapshot(): HistorySnapshot {
	return { turns: [], messages: [], nextSeqNum: 0 };
}

export function normalizeHistorySnapshot(value: unknown): HistorySnapshot {
	if (!isObject(value)) return emptyHistorySnapshot();
	const turns = Array.isArray(value.turns)
		? value.turns.flatMap((turn) => {
				const normalized = normalizeTurn(turn);
				return normalized ? [normalized] : [];
			})
		: [];
	const messages = Array.isArray(value.messages)
		? (value.messages as Message[])
		: turns.flatMap((turn) => (turn.assistant ? [turn.assistant] : []));
	return {
		turns,
		messages,
		nextSeqNum: isValidCursor(value.nextSeqNum) ? value.nextSeqNum : 0,
	};
}

export function createHistorySnapshot(
	records: Iterable<StoredHistoryRecord>,
): HistorySnapshot {
	const turns: HistoryTurn[] = [];
	const messages: Message[] = [];
	const acc = createAccumulator();
	let currentTurn: HistoryTurn | undefined;
	let activeMessage = false;
	let nextSeqNum = 0;

	for (const record of records) {
		if (record.fence) {
			if (record.terminalFence) nextSeqNum = record.seqNum + 1;
			continue;
		}
		if (record.trim || !record.body) continue;

		const event = parseChunk(record.body);
		if (!event) continue;

		if (event.type === "user_message" && typeof event.message === "string") {
			currentTurn = { user: event.message };
			turns.push(currentTurn);
			acc.reset();
			activeMessage = false;
			nextSeqNum = record.seqNum + 1;
			continue;
		}

		if (event.type === "error") {
			if (currentTurn && !currentTurn.assistant && !currentTurn.error) {
				currentTurn.error = {
					type: event.error?.type || "api_error",
					message: event.error?.message || "unknown",
				};
			}
			acc.reset();
			activeMessage = false;
			nextSeqNum = record.seqNum + 1;
			continue;
		}

		if (!isMessageEvent(event)) continue;

		if (event.type === "message_start") {
			acc.reset();
			acc.push(event);
			activeMessage = true;
			continue;
		}

		if (!activeMessage) continue;

		acc.push(event);
		if (event.type === "message_stop") {
			const message = acc.finalMessage();
			messages.push(message);
			if (currentTurn && !currentTurn.assistant && !currentTurn.error) {
				currentTurn.assistant = message;
			}
			acc.reset();
			activeMessage = false;
			nextSeqNum = record.seqNum + 1;
		}
	}

	return {
		turns,
		messages,
		nextSeqNum,
	};
}
