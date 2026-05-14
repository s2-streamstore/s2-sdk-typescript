import { S2 } from "@s2-dev/streamstore";
import { StreamProcessor, type UIMessage } from "@tanstack/ai";
import {
	type Chat,
	type ChatAdapter,
	createChat,
	DEFAULT_ERROR_TEXT,
	type ReplayOptions,
	type ResumableChatConfig,
} from "./adapter.js";
import {
	type TailedStringRecord,
	tailAsSse,
	tailCompactedStringRecords,
} from "./shared.js";

export type { UIMessage } from "@tanstack/ai";
export type {
	MakeResumableOptions,
	ReplayOptions,
	ResumableChatConfig,
	ResumableChatMode,
} from "./adapter.js";

/**
 * Structural version of TanStack AI's stream chunk.
 */
export type StreamChunk = {
	type: string;
	timestamp?: number;
	[key: string]: unknown;
};

type MessagePart = UIMessage["parts"][number];

type SessionSource = (
	messages: UIMessage[],
	context: { abortController: AbortController; signal: AbortSignal },
) => AsyncIterable<StreamChunk> | Promise<AsyncIterable<StreamChunk>>;

interface ActiveGeneration {
	abortController: AbortController;
	runId?: string;
}

export interface TanStackAIChatConfig extends ResumableChatConfig {
	/**
	 * Enables process-local stop support via `stopSession`.
	 *
	 * When false, no active-generation map is created and `stopSession` is a
	 * no-op. Turn this on only if this server instance exposes a stop route.
	 *
	 * @default false
	 */
	enableStop?: boolean;
}

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
	 * Starts a TanStack chat session response in a durable S2 session log.
	 * The replay subscription delivers the stored chunks to clients.
	 */
	makeSessionResponse(
		streamName: string,
		options: MakeSessionResponseOptions,
	): Promise<Response>;
	/**
	 * Stops the active process-local generation when
	 * `enableStop` is enabled.
	 */
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

function normalizePart(value: unknown): MessagePart | null {
	if (!isObjectRecord(value) || typeof value.type !== "string") return null;
	return { ...value, type: value.type } as MessagePart;
}

function createMessagesSnapshotChunk(messages: UIMessage[]): StreamChunk {
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

function findActiveGenerationStartIndex(
	chunks: Array<StreamChunk | null>,
): number {
	let activeIndex = -1;
	for (let index = 0; index < chunks.length; index += 1) {
		const type = chunks[index]?.type;
		if (type === "RUN_STARTED") activeIndex = index;
		if (type === "RUN_FINISHED" || type === "RUN_ERROR") activeIndex = -1;
	}
	return activeIndex;
}

function createSnapshotRecords(
	chunks: Array<StreamChunk | null>,
	nextSeqNum: number,
): TailedStringRecord[] {
	const processor = new StreamProcessor();
	for (const chunk of chunks) {
		if (chunk) processor.processChunk(chunk as never);
	}

	const messages = processor.getMessages() as unknown as UIMessage[];
	if (messages.length === 0) return [];

	return [
		{
			body: JSON.stringify(createMessagesSnapshotChunk(messages)),
			nextSeqNum,
		},
	];
}

function compactSessionRecordsForReplay(
	records: TailedStringRecord[],
): TailedStringRecord[] {
	if (records.length === 0) return records;

	const chunks = records.map((record) => parseStoredChunk(record.body));
	const activeStart = findActiveGenerationStartIndex(chunks);
	if (activeStart !== -1) {
		return [
			...createSnapshotRecords(
				chunks.slice(0, activeStart),
				records[activeStart - 1]?.nextSeqNum ?? 0,
			),
			...records.slice(activeStart),
		];
	}

	return createSnapshotRecords(chunks, records[records.length - 1]!.nextSeqNum);
}

function createMessageTextChunks(message: UIMessage): StreamChunk[] {
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

function createSessionSource({
	incomingMessages,
	source,
	active,
}: {
	incomingMessages: UIMessage[];
	source: SessionSource;
	active: ActiveGeneration;
}): AsyncIterable<StreamChunk> {
	return (async function* () {
		if (incomingMessages.length === 0) return;
		const latest = incomingMessages[incomingMessages.length - 1];
		if (latest?.role === "user") yield* createMessageTextChunks(latest);
		yield* await source(incomingMessages, {
			abortController: active.abortController,
			signal: active.abortController.signal,
		});
	})();
}

function createStopChunk(active: ActiveGeneration): StreamChunk {
	return {
		type: "RUN_FINISHED",
		runId: active.runId ?? `s2-stop-${Date.now()}`,
		model: "s2-stop",
		timestamp: Date.now(),
		finishReason: "stop",
	};
}

function abortableSessionSource(
	source: AsyncIterable<StreamChunk>,
	active: ActiveGeneration,
	onDone: () => void,
): AsyncIterable<StreamChunk> {
	return (async function* () {
		const iterator = source[Symbol.asyncIterator]();
		let abortListener: (() => void) | undefined;
		let terminalSeen = false;
		const signal = active.abortController.signal;
		try {
			while (true) {
				if (signal.aborted) {
					if (!terminalSeen) yield createStopChunk(active);
					return;
				}
				const abort = new Promise<"abort">((resolve) => {
					abortListener = () => resolve("abort");
					signal.addEventListener("abort", abortListener, { once: true });
				});
				let next: IteratorResult<StreamChunk> | "abort";
				try {
					next = await Promise.race([iterator.next(), abort]);
				} catch (err) {
					if (signal.aborted) {
						if (!terminalSeen) yield createStopChunk(active);
						return;
					}
					throw err;
				}
				if (abortListener) {
					signal.removeEventListener("abort", abortListener);
					abortListener = undefined;
				}
				if (next === "abort") {
					if (!terminalSeen) yield createStopChunk(active);
					return;
				}
				if (signal.aborted) {
					if (!terminalSeen) yield createStopChunk(active);
					return;
				}
				if (next.done) return;
				if (
					next.value.type === "RUN_STARTED" &&
					typeof next.value.runId === "string"
				) {
					active.runId = next.value.runId;
				}
				if (isTerminalChunk(next.value)) terminalSeen = true;
				yield next.value;
			}
		} finally {
			if (abortListener) signal.removeEventListener("abort", abortListener);
			await iterator.return?.().catch(() => {});
			onDone();
		}
	})();
}

function normalizeMessages(messages: unknown): UIMessage[] {
	if (!Array.isArray(messages)) return [];
	return messages.flatMap((value, index): UIMessage[] => {
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

function getMessageText(message: UIMessage): string {
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
	config: TanStackAIChatConfig,
): ResumableChat {
	const s2 = new S2({
		accessToken: config.accessToken,
		endpoints: config.endpoints,
	});
	const base = createChat(config, adapter, s2);
	const mode = config.mode ?? "single-use";
	const activeGenerations = config.enableStop
		? new Map<string, ActiveGeneration>()
		: undefined;

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
						compactSessionRecordsForReplay,
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
			if (activeGenerations?.has(streamName)) {
				return new Response("Stream already has an active generation", {
					status: 409,
				});
			}
			const active: ActiveGeneration = {
				abortController: new AbortController(),
			};
			activeGenerations?.set(streamName, active);
			const source = createSessionSource({
				incomingMessages: normalizeMessages(options.messages),
				source: options.source,
				active,
			});
			let response: Response;
			try {
				response = await base.makeResumable(
					streamName,
					abortableSessionSource(source, active, () => {
						if (activeGenerations?.get(streamName) === active) {
							activeGenerations.delete(streamName);
						}
					}),
					{
						delivery: "replay",
						waitUntil: options.waitUntil,
					},
				);
			} catch (err) {
				if (activeGenerations?.get(streamName) === active) {
					activeGenerations.delete(streamName);
				}
				throw err;
			}
			if (
				response.status === 409 &&
				activeGenerations?.get(streamName) === active
			) {
				activeGenerations.delete(streamName);
			}
			return response;
		},
		async stopSession(streamName: string): Promise<Response> {
			if (mode !== "session") {
				throw new Error('stopSession requires mode: "session"');
			}
			const active = activeGenerations?.get(streamName);
			active?.abortController.abort();
			return new Response(null, {
				status: active ? 202 : 204,
				headers: { "Cache-Control": "no-store" },
			});
		},
	};
}
