import { S2, S2Error, type S2Stream } from "@s2-dev/streamstore";
import { StreamProcessor } from "@tanstack/ai";
import {
	type Chat,
	type ChatAdapter,
	createChat,
	DEFAULT_ERROR_TEXT,
	type ReplayOptions,
	type ResumableChatConfig,
} from "./adapter.js";
import {
	stopSharedGeneration,
	type TailedStringBody,
	tailAsSse,
	tailCompactedStringRecords,
} from "./shared.js";

export type {
	MakeResumableOptions,
	ReplayOptions,
	ResumableChatConfig,
	ResumableChatMode,
} from "./adapter.js";

/**
 * Structural version of TanStack AI's `StreamChunk`.
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
	role: "system" | "user" | "assistant";
	parts: ChatMessagePart[];
	[key: string]: unknown;
};

type SessionSource = (
	messages: ChatMessage[],
	context: { abortController: AbortController; signal: AbortSignal },
) => AsyncIterable<StreamChunk> | Promise<AsyncIterable<StreamChunk>>;

export interface MakeSessionResponseOptions {
	/**
	 * TanStack UI messages from the send request. The helper passes them to
	 * `source`; only stream events are stored in S2.
	 */
	messages: unknown;
	/**
	 * Assistant/model stream factory. It receives the submitted messages after
	 * structural normalization.
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
	/** Stops the active session generation, if one is still running. */
	stopSession(streamName: string): Promise<Response>;
};

const SSE_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache",
	Connection: "keep-alive",
	"X-Accel-Buffering": "no",
} as const;

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
	// `TEXT_MESSAGE_CONTENT` carries both an incremental `delta` and the
	// running aggregate `content`. Only `delta` is needed durably; dropping
	// `content` keeps the stored stream close to true diff size.
	prepareForStorage(chunk) {
		if (chunk.type !== "TEXT_MESSAGE_CONTENT") return chunk;
		const { content: _content, ...rest } = chunk;
		return rest;
	},
	responseHeaders: SSE_HEADERS,
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizePart(value: unknown): ChatMessagePart | null {
	if (!isObjectRecord(value) || typeof value.type !== "string") return null;
	return { ...value, type: value.type };
}

function messagesSnapshotChunk(messages: ChatMessage[]): StreamChunk {
	return {
		type: "MESSAGES_SNAPSHOT",
		timestamp: Date.now(),
		messages: messages.map((message) => ({
			...message,
			parts: message.parts.map((part) => ({ ...part })),
		})),
	};
}

function parseStoredChunk(body: string): StreamChunk | null {
	try {
		const value = JSON.parse(body);
		if (!isObjectRecord(value) || typeof value.type !== "string") return null;
		return value as StreamChunk;
	} catch {
		return null;
	}
}

function isTerminalChunk(chunk: StreamChunk | null): boolean {
	return chunk?.type === "RUN_FINISHED" || chunk?.type === "RUN_ERROR";
}

function activeRunStartIndex(chunks: Array<StreamChunk | null>): number {
	let activeIndex = -1;
	for (let index = 0; index < chunks.length; index += 1) {
		const type = chunks[index]?.type;
		if (type === "RUN_STARTED") activeIndex = index;
		if (type === "RUN_FINISHED" || type === "RUN_ERROR") activeIndex = -1;
	}
	return activeIndex;
}

async function activeRunId(stream: S2Stream): Promise<string | undefined> {
	const session = await stream
		.readSession(
			{
				start: { from: { seqNum: 0 }, clamp: true },
				stop: { waitSecs: 0 },
			},
			{ as: "string" },
		)
		.catch((error: unknown) => {
			if (error instanceof S2Error && error.status === 404) return null;
			throw error;
		});
	if (!session) return undefined;

	let runId: string | undefined;
	try {
		for await (const record of session) {
			const chunk = parseStoredChunk(record.body);
			if (chunk?.type === "RUN_STARTED") {
				runId = typeof chunk.runId === "string" ? chunk.runId : undefined;
			}
			if (isTerminalChunk(chunk)) runId = undefined;
		}
	} finally {
		await session[Symbol.asyncDispose]?.();
	}
	return runId;
}

function snapshotFromChunks(
	chunks: Array<StreamChunk | null>,
	nextSeqNum: number,
): TailedStringBody[] {
	const processor = new StreamProcessor();
	for (const chunk of chunks) {
		if (chunk) processor.processChunk(chunk as never);
	}

	const messages = processor.getMessages() as unknown as ChatMessage[];
	if (messages.length === 0) return [];

	return [
		{
			body: JSON.stringify(messagesSnapshotChunk(messages)),
			nextSeqNum,
		},
	];
}

function compactSessionReplay(records: TailedStringBody[]): TailedStringBody[] {
	if (records.length === 0) return records;

	const chunks = records.map((record) => parseStoredChunk(record.body));
	const activeStart = activeRunStartIndex(chunks);
	if (activeStart !== -1) {
		return [
			...snapshotFromChunks(
				chunks.slice(0, activeStart),
				records[activeStart - 1]?.nextSeqNum ?? 0,
			),
			...records.slice(activeStart),
		];
	}

	return snapshotFromChunks(chunks, records[records.length - 1]!.nextSeqNum);
}

function messageTextChunks(message: ChatMessage): StreamChunk[] {
	const timestamp = Date.now();
	const messageId = message.id;
	const text = getMessageText(message);
	return [
		{ type: "TEXT_MESSAGE_START", timestamp, messageId, role: message.role },
		...(text
			? [{ type: "TEXT_MESSAGE_CONTENT", timestamp, messageId, delta: text }]
			: []),
		{ type: "TEXT_MESSAGE_END", timestamp, messageId },
	];
}

function makeSessionSource({
	incomingMessages,
	source,
	abortController,
}: {
	incomingMessages: ChatMessage[];
	source: SessionSource;
	abortController: AbortController;
}): AsyncIterable<StreamChunk> {
	return (async function* () {
		if (incomingMessages.length === 0) return;
		const latest = incomingMessages[incomingMessages.length - 1];
		if (latest?.role === "user") yield* messageTextChunks(latest);
		yield* await source(incomingMessages, {
			abortController,
			signal: abortController.signal,
		});
	})();
}

function abortableSource<T>(
	source: AsyncIterable<T>,
	signal: AbortSignal,
	onDone: () => void,
): AsyncIterable<T> {
	return (async function* () {
		const iterator = source[Symbol.asyncIterator]();
		let abortListener: (() => void) | undefined;
		try {
			while (!signal.aborted) {
				const abort = new Promise<"abort">((resolve) => {
					abortListener = () => resolve("abort");
					signal.addEventListener("abort", abortListener, { once: true });
				});
				const next = await Promise.race([iterator.next(), abort]);
				if (abortListener) {
					signal.removeEventListener("abort", abortListener);
					abortListener = undefined;
				}
				if (next === "abort" || next.done) return;
				yield next.value;
			}
		} finally {
			if (abortListener) signal.removeEventListener("abort", abortListener);
			await iterator.return?.().catch(() => {});
			onDone();
		}
	})();
}

function normalizeMessages(messages: unknown): ChatMessage[] {
	if (!Array.isArray(messages)) return [];
	return messages.flatMap((value, index): ChatMessage[] => {
		if (!isObjectRecord(value)) return [];
		if (
			value.role !== "system" &&
			value.role !== "user" &&
			value.role !== "assistant"
		) {
			return [];
		}
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

function getMessageText(message: ChatMessage): string {
	return message.parts
		.filter(
			(part): part is { type: "text"; content: string } =>
				part.type === "text" && typeof part.content === "string",
		)
		.map((part) => part.content)
		.join("");
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
	const mode = config.mode ?? "single-use";
	const abortControllers = new Map<string, AbortController>();

	return {
		...base,
		async replay(
			streamName: string,
			options?: ReplayOptions,
		): Promise<Response> {
			if (mode === "session" && options?.fromSeqNum === undefined) {
				return tailAsSse(
					tailCompactedStringRecords(
						s2.basin(config.basin).stream(streamName),
						compactSessionReplay,
					),
					SSE_HEADERS,
				);
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
			const abortController = new AbortController();
			abortControllers.set(streamName, abortController);
			const source = makeSessionSource({
				incomingMessages: normalizeMessages(options.messages),
				source: options.source,
				abortController,
			});
			return base.makeResumable(
				streamName,
				abortableSource(source, abortController.signal, () => {
					if (abortControllers.get(streamName) === abortController) {
						abortControllers.delete(streamName);
					}
				}),
				{
					delivery: "replay",
					waitUntil: options.waitUntil,
				},
			);
		},
		async stopSession(streamName: string): Promise<Response> {
			if (mode !== "session") {
				throw new Error('stopSession requires mode: "session"');
			}
			const stream = s2.basin(config.basin).stream(streamName);
			const runId = await activeRunId(stream);
			const stopped = await stopSharedGeneration({
				stream,
				body: JSON.stringify({
					type: "RUN_FINISHED",
					runId: runId ?? `s2-stop-${Date.now()}`,
					model: "s2-stop",
					timestamp: Date.now(),
					finishReason: "stop",
				}),
			});
			abortControllers.get(streamName)?.abort();
			abortControllers.delete(streamName);
			return new Response(null, {
				status: stopped ? 202 : 204,
				headers: { "Cache-Control": "no-store" },
			});
		},
	};
}
