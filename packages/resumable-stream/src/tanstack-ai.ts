import { S2, S2Error, type S2Stream } from "@s2-dev/streamstore";
import {
	type Chat,
	type ChatAdapter,
	createChat,
	DEFAULT_ERROR_TEXT,
	type ResumableChatConfig,
} from "./adapter.js";

export type {
	MakeResumableOptions,
	ReplayOptions,
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

export type MessageRole = "user" | "assistant";

export type SnapshotMessagePart = {
	type: string;
	content?: unknown;
	[key: string]: unknown;
};

export type SnapshotMessage = {
	id: string;
	role: MessageRole;
	parts: SnapshotMessagePart[];
	[key: string]: unknown;
};

export type TextMessage = {
	role: MessageRole;
	content: string;
};

export type ChatSnapshot = {
	messages: SnapshotMessage[];
	fromSeqNum: number;
};

export interface MakeSessionResponseOptions {
	/** TanStack UI messages from the send request. Preserved in the durable snapshot. */
	messages: unknown;
	/** Assistant/model stream to append after the message snapshot. */
	source: AsyncIterable<StreamChunk>;
	/**
	 * Keeps background S2 persistence alive after the response returns.
	 * Pass the platform-provided `waitUntil` (Vercel/Cloudflare).
	 */
	waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Server-side helpers for writing and replaying resumable TanStack AI streams.
 */
export type ResumableChat = Chat<StreamChunk> & {
	/** Creates the S2 stream if needed. */
	ensureStream(streamName: string): Promise<void>;
	/**
	 * Starts a shared-live TanStack chat session and returns immediately.
	 * The durable replay subscription is the source of truth for chunks.
	 */
	makeSessionResponse(
		streamName: string,
		options: MakeSessionResponseOptions,
	): Promise<Response>;
	/** Reads the current shared-live transcript snapshot without tailing. */
	getSessionSnapshot(streamName: string): Promise<ChatSnapshot>;
	/** Reads the current shared-live transcript snapshot as a JSON response. */
	getSessionSnapshotResponse(streamName: string): Promise<Response>;
};

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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizePart(value: unknown): SnapshotMessagePart | null {
	if (!isObjectRecord(value) || typeof value.type !== "string") return null;
	return { ...value, type: value.type };
}

function isFenceOrTrimRecord(record: {
	headers?: ReadonlyArray<readonly [string, string]>;
}): boolean {
	return (
		record.headers?.length === 1 &&
		record.headers[0]?.[0] === "" &&
		(record.headers[0]?.[1] === "fence" || record.headers[0]?.[1] === "trim")
	);
}

function messagesSnapshotChunk(messages: SnapshotMessage[]): StreamChunk {
	return {
		type: "MESSAGES_SNAPSHOT",
		timestamp: Date.now(),
		messages,
	};
}

function isSnapshotMessage(value: unknown): value is SnapshotMessage {
	if (!isObjectRecord(value)) return false;
	return (
		(value.role === "user" || value.role === "assistant") &&
		typeof value.id === "string" &&
		Array.isArray(value.parts) &&
		value.parts.every(
			(part) => isObjectRecord(part) && typeof part.type === "string",
		)
	);
}

function normalizeSnapshotMessages(value: unknown): SnapshotMessage[] | null {
	if (!Array.isArray(value) || !value.every(isSnapshotMessage)) return null;
	return value.map((message) => ({
		...message,
		parts: message.parts.map((part) => ({ ...part })),
	}));
}

function ensureMessage(
	messages: SnapshotMessage[],
	messageId: string,
	role: MessageRole = "assistant",
): SnapshotMessage[] {
	if (messages.some((message) => message.id === messageId)) return messages;
	return [
		...messages,
		{
			id: messageId,
			role,
			parts: [{ type: "text", content: "" }],
		},
	];
}

function withMessageText(
	message: SnapshotMessage,
	text: string,
): SnapshotMessage {
	let wroteText = false;
	const parts = message.parts.map((part) => {
		if (part.type !== "text" || wroteText) return part;
		wroteText = true;
		return { ...part, content: text };
	});
	if (!wroteText) {
		parts.push({ type: "text", content: text });
	}
	return { ...message, parts };
}

function setMessageText(
	messages: SnapshotMessage[],
	messageId: string,
	text: string,
): SnapshotMessage[] {
	return ensureMessage(messages, messageId).map((message) =>
		message.id === messageId ? withMessageText(message, text) : message,
	);
}

function appendMessageText(
	messages: SnapshotMessage[],
	messageId: string,
	text: string,
): SnapshotMessage[] {
	const existingMessages = ensureMessage(messages, messageId);
	const current = existingMessages.find((message) => message.id === messageId);
	return setMessageText(
		existingMessages,
		messageId,
		`${current ? getMessageText(current) : ""}${text}`,
	);
}

function applyStreamChunkToSnapshot(
	messages: SnapshotMessage[],
	chunk: StreamChunk,
): SnapshotMessage[] {
	if (chunk.type === "MESSAGES_SNAPSHOT") {
		return normalizeSnapshotMessages(chunk.messages) ?? messages;
	}

	if (chunk.type === "TEXT_MESSAGE_START") {
		if (typeof chunk.messageId !== "string") return messages;
		const role = chunk.role === "user" ? "user" : "assistant";
		return ensureMessage(messages, chunk.messageId, role);
	}

	if (chunk.type === "TEXT_MESSAGE_CONTENT") {
		if (typeof chunk.messageId !== "string") return messages;
		if (typeof chunk.delta === "string" && chunk.delta) {
			return appendMessageText(messages, chunk.messageId, chunk.delta);
		}
		if (typeof chunk.content !== "string" || !chunk.content) return messages;

		const existingMessages = ensureMessage(messages, chunk.messageId);
		const current = existingMessages.find(
			(message) => message.id === chunk.messageId,
		);
		const currentText = current ? getMessageText(current) : "";
		const nextText = chunk.content.startsWith(currentText)
			? chunk.content
			: currentText.startsWith(chunk.content)
				? currentText
				: currentText + chunk.content;
		return setMessageText(existingMessages, chunk.messageId, nextText);
	}

	if (chunk.type === "RUN_ERROR") {
		const message =
			typeof chunk.message === "string"
				? chunk.message
				: typeof (chunk.error as { message?: unknown } | undefined)?.message ===
						"string"
					? (chunk.error as { message: string }).message
					: "Unknown model error";
		return appendMessageText(
			messages,
			typeof chunk.messageId === "string"
				? chunk.messageId
				: "fallback-assistant",
			`\n\n[error] ${message}`,
		);
	}

	return messages;
}

async function readSessionSnapshot(stream: S2Stream): Promise<ChatSnapshot> {
	const session = await stream.readSession(
		{ start: { from: { seqNum: 0 } }, stop: { waitSecs: 0 } },
		{ as: "string" },
	);

	let messages: SnapshotMessage[] = [];
	let fromSeqNum = 0;
	try {
		for await (const record of session) {
			fromSeqNum = record.seqNum + 1;
			if (isFenceOrTrimRecord(record) || !record.body) continue;
			try {
				messages = applyStreamChunkToSnapshot(
					messages,
					JSON.parse(record.body) as StreamChunk,
				);
			} catch {
				// Ignore malformed chunk records so snapshot loading remains best-effort.
			}
		}
	} finally {
		await session[Symbol.asyncDispose]?.();
	}

	return { messages, fromSeqNum };
}

function prependMessagesSnapshot(
	messages: SnapshotMessage[],
	source: AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
	return (async function* () {
		yield messagesSnapshotChunk(messages);
		yield* source;
	})();
}

export function normalizeMessages(messages: unknown): SnapshotMessage[] {
	if (!Array.isArray(messages)) return [];
	return messages.flatMap((value, index): SnapshotMessage[] => {
		if (!isObjectRecord(value)) return [];
		if (value.role !== "user" && value.role !== "assistant") return [];
		const rawParts = Array.isArray(value.parts) ? value.parts : [];
		return [
			{
				...value,
				id: typeof value.id === "string" ? value.id : `message-${index}`,
				role: value.role,
				parts: rawParts.flatMap((part) => {
					const normalized = normalizePart(part);
					return normalized ? [normalized] : [];
				}),
			},
		];
	});
}

export function getMessageText(message: SnapshotMessage): string {
	return message.parts
		.filter(
			(part): part is { type: "text"; content: string } =>
				part.type === "text" && typeof part.content === "string",
		)
		.map((part) => part.content)
		.join("");
}

export function getLatestUserText(messages: unknown): string | null {
	const normalized = normalizeMessages(messages);
	for (let i = normalized.length - 1; i >= 0; i -= 1) {
		const message = normalized[i];
		if (message?.role !== "user") continue;
		const text = getMessageText(message);
		if (text) return text;
	}
	return null;
}

export function toTextMessages(messages: unknown): TextMessage[] {
	return normalizeMessages(messages).flatMap((message) => {
		const content = getMessageText(message);
		return content ? [{ role: message.role, content }] : [];
	});
}

/** Creates server-side helpers for making TanStack AI streams resumable in S2. */
export function createResumableChat(
	config: ResumableChatConfig,
): ResumableChat {
	const base = createChat(config, adapter);
	const s2 = new S2({
		accessToken: config.accessToken,
		endpoints: config.endpoints,
	});
	const basin = s2.basin(config.basin);
	const streamReuse = config.streamReuse ?? "single-use";

	const ensureStream = async (streamName: string): Promise<void> => {
		await basin.streams
			.create({ stream: streamName })
			.catch((error: unknown) => {
				if (!(error instanceof S2Error && error.status === 409)) throw error;
			});
	};

	return {
		...base,
		ensureStream,
		async makeSessionResponse(
			streamName: string,
			options: MakeSessionResponseOptions,
		): Promise<Response> {
			if (streamReuse !== "shared-live") {
				throw new Error(
					'makeSessionResponse requires streamReuse: "shared-live"',
				);
			}
			const messages = normalizeMessages(options.messages);
			await ensureStream(streamName);
			return base.makeResumable(
				streamName,
				prependMessagesSnapshot(messages, options.source),
				{
					responseMode: "background",
					waitUntil: options.waitUntil,
				},
			);
		},
		async getSessionSnapshot(streamName: string): Promise<ChatSnapshot> {
			await ensureStream(streamName);
			return readSessionSnapshot(basin.stream(streamName));
		},
		async getSessionSnapshotResponse(streamName: string): Promise<Response> {
			await ensureStream(streamName);
			return Response.json(
				await readSessionSnapshot(basin.stream(streamName)),
				{
					headers: { "Cache-Control": "no-store" },
				},
			);
		},
	};
}
