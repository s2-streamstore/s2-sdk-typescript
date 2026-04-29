import { S2, type S2Stream } from "@s2-dev/streamstore";
import {
	type Chat,
	type ChatAdapter,
	createChat,
	DEFAULT_ERROR_TEXT,
	type ReplayOptions,
	type ResumableChatConfig,
} from "./adapter.js";
import { isFenceRecord, isTrimRecord } from "./protocol.js";
import { tailAsSse, tailStringRecords } from "./shared.js";

export type {
	MakeResumableOptions,
	ReplayOptions,
	ResumableChatConfig,
	ResumableChatMode,
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

type ChatMessagePart = {
	type: string;
	content?: unknown;
	[key: string]: unknown;
};

export type ChatMessage = {
	id: string;
	role: "user" | "assistant";
	parts: ChatMessagePart[];
	[key: string]: unknown;
};

export type TextMessage = {
	role: ChatMessage["role"];
	content: string;
};

type SessionSource = (
	messages: ChatMessage[],
) => AsyncIterable<StreamChunk> | Promise<AsyncIterable<StreamChunk>>;

type ChatSnapshot = {
	messages: ChatMessage[];
	fromSeqNum: number;
};

export interface MakeSessionResponseOptions {
	/**
	 * TanStack UI messages from the send request. The helper reads S2, keeps
	 * stored messages, and appends the latest user message from this array if it
	 * is not already stored.
	 */
	messages: unknown;
	/**
	 * Assistant/model stream factory. It receives messages rebuilt from S2 plus
	 * the latest submitted user message.
	 */
	source: SessionSource;
	/**
	 * Keeps S2 persistence alive after the response returns.
	 * Pass the platform-provided `waitUntil` (Vercel/Cloudflare).
	 */
	waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Server-side helpers for writing and replaying resumable TanStack AI streams.
 */
export type ResumableChat = Chat<StreamChunk> & {
	/**
	 * Starts a TanStack chat session and returns immediately.
	 * The replay subscription delivers the stored chunks to clients.
	 */
	makeSessionResponse(
		streamName: string,
		options: MakeSessionResponseOptions,
	): Promise<Response>;
};

const SSE_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache",
	Connection: "keep-alive",
	"X-Accel-Buffering": "no",
} as const;

function sanitizeChunkForStorage(chunk: StreamChunk): StreamChunk {
	if (chunk.type !== "TEXT_MESSAGE_CONTENT") return chunk;
	const next = { ...chunk };
	delete next.content;
	return next;
}

const adapter: ChatAdapter<StreamChunk> = {
	makeErrorChunk(err, onError) {
		const message = onError ? onError(err) : DEFAULT_ERROR_TEXT;
		return {
			type: "RUN_ERROR",
			timestamp: Date.now(),
			message,
			error: { message },
		};
	},
	prepareForStorage: sanitizeChunkForStorage,
	responseHeaders: SSE_HEADERS,
};

type StreamProcessorInstance = {
	processChunk(chunk: unknown): void;
	getMessages(): unknown[];
};

type StreamProcessorConstructor = new (options?: {
	initialMessages?: unknown[];
}) => StreamProcessorInstance;

let streamProcessorPromise:
	| Promise<StreamProcessorConstructor | null>
	| undefined;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizePart(value: unknown): ChatMessagePart | null {
	if (!isObjectRecord(value) || typeof value.type !== "string") return null;
	return { ...value, type: value.type };
}

function ensureMessage(
	messages: ChatMessage[],
	messageId: string,
	role: ChatMessage["role"] = "assistant",
): ChatMessage[] {
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

function updateMessageText(
	messages: ChatMessage[],
	messageId: string,
	updateText: (current: string) => string,
): ChatMessage[] {
	return ensureMessage(messages, messageId).map((message) => {
		if (message.id !== messageId) return message;
		const text = updateText(getMessageText(message));
		let wrote = false;
		const parts = message.parts.map((part) => {
			if (part.type !== "text" || wrote) return part;
			wrote = true;
			return { ...part, content: text };
		});
		if (!wrote) parts.push({ type: "text", content: text });
		return { ...message, parts };
	});
}

function mergeTextValue(current: string, incoming: string): string {
	if (incoming.startsWith(current)) return incoming;
	if (current.startsWith(incoming)) return current;
	return current + incoming;
}

function stripGeneratedDates(messages: ChatMessage[]): ChatMessage[] {
	return messages.map((message) => {
		if (!(message.createdAt instanceof Date)) return message;
		const { createdAt: _, ...rest } = message;
		return rest;
	});
}

async function getStreamProcessor(): Promise<StreamProcessorConstructor | null> {
	if (!streamProcessorPromise) {
		streamProcessorPromise = import("@tanstack/ai")
			.then((mod) =>
				typeof mod.StreamProcessor === "function"
					? (mod.StreamProcessor as StreamProcessorConstructor)
					: null,
			)
			.catch(() => null);
	}
	return streamProcessorPromise;
}

async function rebuildMessagesFromChunks(
	chunks: StreamChunk[],
): Promise<ChatMessage[]> {
	const StreamProcessor = await getStreamProcessor();
	if (StreamProcessor) {
		try {
			const processor = new StreamProcessor();
			for (const chunk of chunks) {
				processor.processChunk(chunk);
			}
			return stripGeneratedDates(normalizeMessages(processor.getMessages()));
		} catch {
			// Fall through to the structural replay below.
		}
	}

	let messages: ChatMessage[] = [];
	for (const chunk of chunks) {
		messages = applyStreamChunkToSnapshot(messages, chunk);
	}
	return messages;
}

function applyStreamChunkToSnapshot(
	messages: ChatMessage[],
	chunk: StreamChunk,
): ChatMessage[] {
	if (chunk.type === "TEXT_MESSAGE_START") {
		if (typeof chunk.messageId !== "string") return messages;
		const role = chunk.role === "user" ? "user" : "assistant";
		return ensureMessage(messages, chunk.messageId, role);
	}

	if (chunk.type === "TEXT_MESSAGE_CONTENT") {
		if (typeof chunk.messageId !== "string") return messages;
		const messageId = chunk.messageId;
		if (typeof chunk.delta === "string" && chunk.delta) {
			const delta = chunk.delta;
			return updateMessageText(messages, messageId, (current) => current + delta);
		}
		if (typeof chunk.content === "string" && chunk.content) {
			const content = chunk.content;
			return updateMessageText(messages, messageId, (current) =>
				mergeTextValue(current, content),
			);
		}
		return messages;
	}

	if (chunk.type === "RUN_ERROR") {
		const errMessage =
			isObjectRecord(chunk.error) && typeof chunk.error.message === "string"
				? chunk.error.message
				: undefined;
		const message =
			(typeof chunk.message === "string" ? chunk.message : undefined) ??
			errMessage ??
			"Unknown model error";
		const messageId =
			typeof chunk.messageId === "string"
				? chunk.messageId
				: "fallback-assistant";
		return updateMessageText(
			messages,
			messageId,
			(current) => `${current}\n\n[error] ${message}`,
		);
	}

	return messages;
}

async function readSessionSnapshot(stream: S2Stream): Promise<ChatSnapshot> {
	const session = await stream.readSession(
		{ start: { from: { seqNum: 0 } }, stop: { waitSecs: 0 } },
		{ as: "string" },
	);

	const chunks: StreamChunk[] = [];
	let fromSeqNum = 0;
	try {
		for await (const record of session) {
			fromSeqNum = record.seqNum + 1;
			if (isFenceRecord(record) || isTrimRecord(record) || !record.body)
				continue;
			try {
				const chunk = JSON.parse(record.body) as unknown;
				if (isObjectRecord(chunk) && typeof chunk.type === "string") {
					if (chunk.type === "MESSAGES_SNAPSHOT") continue;
					chunks.push(chunk as StreamChunk);
				}
			} catch {
				// Ignore malformed chunk records so snapshot loading remains best-effort.
			}
		}
	} finally {
		await session[Symbol.asyncDispose]?.();
	}

	return { messages: await rebuildMessagesFromChunks(chunks), fromSeqNum };
}

function replaySessionWithSnapshot(stream: S2Stream): Response {
	return tailAsSse(
		(async function* () {
			const snapshot = await readSessionSnapshot(stream);
			yield {
				body: JSON.stringify({
					type: "MESSAGES_SNAPSHOT",
					timestamp: Date.now(),
					messages: snapshot.messages,
				}),
				nextSeqNum: snapshot.fromSeqNum,
			};
			yield* tailStringRecords(stream, snapshot.fromSeqNum);
		})(),
		SSE_HEADERS,
	);
}

function cloneMessage(message: ChatMessage): ChatMessage {
	return {
		...message,
		parts: message.parts.map((part) => ({ ...part })),
	};
}

function latestUserMessage(messages: ChatMessage[]): ChatMessage | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "user" && getMessageText(message)) return message;
	}
	return null;
}

function needsModelResponse(
	currentMessages: ChatMessage[],
	submittedMessage: ChatMessage,
): boolean {
	const currentIndex = currentMessages.findIndex(
		(currentMessage) => currentMessage.id === submittedMessage.id,
	);
	if (currentIndex < 0) return true;
	return !currentMessages
		.slice(currentIndex + 1)
		.some((currentMessage) => currentMessage.role === "assistant");
}

function messageEchoChunks(message: ChatMessage): StreamChunk[] {
	const timestamp = Date.now();
	const text = getMessageText(message);
	return [
		{
			type: "TEXT_MESSAGE_START",
			timestamp,
			messageId: message.id,
			role: message.role,
			model: "client",
		},
		...(text
			? [
					{
						type: "TEXT_MESSAGE_CONTENT",
						timestamp,
						messageId: message.id,
						delta: text,
						model: "client",
					},
				]
			: []),
		{
			type: "TEXT_MESSAGE_END",
			timestamp,
			messageId: message.id,
			model: "client",
		},
	];
}

function makeSessionSource({
	readCurrentSnapshot,
	incomingMessages,
	source,
}: {
	readCurrentSnapshot: () => Promise<ChatSnapshot>;
	incomingMessages: ChatMessage[];
	source: SessionSource;
}): AsyncIterable<StreamChunk> {
	return (async function* () {
		const currentSnapshot = await readCurrentSnapshot();
		const submitted = latestUserMessage(incomingMessages);
		if (!submitted) return;

		const alreadyStored = currentSnapshot.messages.some(
			(message) => message.id === submitted.id,
		);
		if (
			alreadyStored &&
			!needsModelResponse(currentSnapshot.messages, submitted)
		) {
			return;
		}

		const baseMessages = currentSnapshot.messages.map(cloneMessage);
		const messagesForModel = alreadyStored
			? baseMessages
			: [...baseMessages, cloneMessage(submitted)];

		if (!alreadyStored) yield* messageEchoChunks(submitted);
		yield* await source(messagesForModel);
	})();
}

export function normalizeMessages(messages: unknown): ChatMessage[] {
	if (!Array.isArray(messages)) return [];
	return messages.flatMap((value, index): ChatMessage[] => {
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

export function getMessageText(message: ChatMessage): string {
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
	const mode = config.mode ?? "single-use";

	return {
		...base,
		async replay(
			streamName: string,
			options?: ReplayOptions,
		): Promise<Response> {
			if (mode === "session" && options?.fromSeqNum === undefined) {
				return replaySessionWithSnapshot(basin.stream(streamName));
			}
			return base.replay(streamName, options);
		},
		async makeSessionResponse(
			streamName: string,
			options: MakeSessionResponseOptions,
		): Promise<Response> {
			if (mode !== "session") {
				throw new Error('makeSessionResponse requires mode: "session"');
			}
			const source = makeSessionSource({
				readCurrentSnapshot: () =>
					readSessionSnapshot(basin.stream(streamName)),
				incomingMessages: normalizeMessages(options.messages),
				source: options.source,
			});
			return base.makeResumable(streamName, source, {
				delivery: "replay",
				waitUntil: options.waitUntil,
			});
		},
	};
}
