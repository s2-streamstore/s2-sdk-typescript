import type {
	AppendAck,
	ReadInput,
	ReadRecord,
	S2Endpoints,
	S2EndpointsInit,
	S2Stream,
	StreamPosition,
} from "@s2-dev/streamstore";
import {
	AppendInput,
	AppendRecord,
	FencingTokenMismatchError,
	randomToken,
	S2,
	SeqNumMismatchError,
} from "@s2-dev/streamstore";
import { appendFenceCommand, persistToS2 } from "./protocol.js";
import {
	claimSharedGeneration,
	replayActiveGenerationStringBodies,
} from "./shared.js";

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LINGER_DURATION = 50;
const DEFAULT_LEASE_DURATION_MS = 5 * 1000;
const DEFAULT_ERROR_TEXT = "An error occurred.";
const DEFAULT_SESSION_READ_BATCH_SIZE = 1000;
const SESSION_EVENT_CONTENT_TYPE =
	"application/vnd.s2.tanstack-ai-session+json";

type SseEncodeOptions = { doneMarker?: boolean };
type SseReadOptions = { stopOnDone?: boolean };
type ConnectionStreamName =
	| string
	| ((
			messages: ChatMessage[],
			data: Record<string, unknown> | undefined,
	  ) => string);

export const SSE_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache",
	Connection: "keep-alive",
} as const;

/**
 * Structural version of TanStack AI's `StreamChunk`.
 *
 * This package intentionally does not import `@tanstack/ai` at runtime. The
 * actual `StreamChunk` type from TanStack AI is structurally assignable here.
 */
export type StreamChunk = {
	type: string;
	timestamp?: number;
	[key: string]: unknown;
};

export type ChatMessage = Record<string, unknown>;
export type FetchClient = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export type S2SessionEvent =
	| {
			kind: "message";
			message: ChatMessage;
			messageId?: string;
			runId?: string;
			timestamp: string;
	  }
	| {
			kind: "run-start";
			runId: string;
			data?: Record<string, unknown>;
			timestamp: string;
	  }
	| {
			kind: "chunk";
			runId: string;
			chunk: StreamChunk;
			timestamp: string;
	  }
	| {
			kind: "run-finish";
			runId: string;
			timestamp: string;
	  }
	| {
			kind: "run-error";
			runId: string;
			error: { message: string };
			chunk: StreamChunk;
			timestamp: string;
	  };

export interface S2SessionRecord {
	seqNum: number;
	timestamp: string;
	event: S2SessionEvent;
}

export interface S2SessionSnapshot {
	messages: ChatMessage[];
	events: S2SessionRecord[];
	nextSeqNum: number;
	tail?: StreamPosition;
}

export interface Connection {
	connect(
		messages: ChatMessage[],
		data?: Record<string, unknown>,
		abortSignal?: AbortSignal,
	): AsyncIterable<StreamChunk>;
}

export interface ResumableGenerationConfig {
	/** S2 access token. */
	accessToken: string;
	/** Basin used for resumable streams. */
	basin: string;
	/** Optional endpoint overrides, for example when using `s2-lite`. */
	endpoints?: S2Endpoints | S2EndpointsInit;
	/** Maximum number of chunks to append in one batch. Defaults to `10`. */
	batchSize?: number;
	/** Maximum time to buffer a batch before flushing, in milliseconds. Defaults to `50`. */
	lingerDuration?: number;
	/**
	 * How to map generations to S2 streams.
	 * - `single-use`: Each generation gets a dedicated stream.
	 * - `shared`: Later generations reuse a stream after the previous one ends.
	 */
	streamReuse?: "single-use" | "shared";
	/**
	 * Only applies to `streamReuse: "shared"`.
	 *
	 * If an active generation stops writing for this long, a new generation can
	 * take over the stream. Defaults to 5 seconds.
	 */
	leaseDurationMs?: number;
	/**
	 * Maps an upstream error to the message carried by a `RUN_ERROR` event.
	 *
	 * @default () => "An error occurred."
	 */
	onError?: (error: unknown) => string;
}

export interface MakeResumableOptions {
	/**
	 * Keeps the background S2 persistence alive after the response returns.
	 * On platforms like Vercel / Cloudflare, pass the platform-provided
	 * `waitUntil` equivalent.
	 */
	waitUntil?: (promise: Promise<unknown>) => void;
}

export interface ResumableGeneration {
	/**
	 * Starts making a TanStack AI `StreamChunk` stream resumable in S2 and
	 * returns the stream as an SSE `Response`.
	 */
	makeResumable(
		streamName: string,
		source: AsyncIterable<StreamChunk>,
		options?: MakeResumableOptions,
	): Promise<Response>;
	/**
	 * Replays the currently active generation as TanStack AI SSE.
	 * Returns `204` when there is no active generation to replay.
	 */
	replay(streamName: string): Promise<Response>;
}

export interface HttpConnectionOptions {
	url: string | (() => string);
	headers?: HeadersInit | (() => HeadersInit);
	fetchClient?: FetchClient;
	streamName?: ConnectionStreamName;
}

export interface SessionRequestBody {
	messages?: ChatMessage[];
	data?: Record<string, unknown>;
	streamName?: string;
	sessionId?: string;
	[key: string]: unknown;
}

export interface HttpSessionHandlerConfig extends ResumableGenerationConfig {
	resolveStreamName?: (context: {
		request: Request;
		body?: SessionRequestBody;
	}) => string | Promise<string>;
	produce: (context: {
		request: Request;
		body: SessionRequestBody;
		messages: ChatMessage[];
		data?: Record<string, unknown>;
		streamName: string;
		sessionId?: string;
		abortSignal: AbortSignal;
	}) => AsyncIterable<StreamChunk> | Promise<AsyncIterable<StreamChunk>>;
}

export interface HttpSessionHandler {
	handle(request: Request, options?: MakeResumableOptions): Promise<Response>;
	POST(request: Request, options?: MakeResumableOptions): Promise<Response>;
	GET(request: Request): Promise<Response>;
	replay(streamName: string): Promise<Response>;
}

async function* readableToAsyncIterable<T>(
	rs: ReadableStream<T>,
): AsyncIterable<T> {
	const reader = rs.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

function asyncIterableToReadableStream<T>(
	source: AsyncIterable<T>,
): ReadableStream<T> {
	let iterator: AsyncIterator<T> | undefined;
	return new ReadableStream<T>({
		async pull(controller) {
			if (!iterator) iterator = source[Symbol.asyncIterator]();
			try {
				const { done, value } = await iterator.next();
				if (done) {
					controller.close();
					return;
				}
				controller.enqueue(value);
			} catch (err) {
				controller.error(err);
				await iterator?.return?.().catch(() => {});
			}
		},
		async cancel() {
			await iterator?.return?.().catch(() => {});
		},
	});
}

function makeErrorChunk(
	err: unknown,
	onError?: (error: unknown) => string,
): StreamChunk {
	const message = onError ? onError(err) : DEFAULT_ERROR_TEXT;
	return {
		type: "RUN_ERROR",
		timestamp: Date.now(),
		error: { message },
	};
}

function errorMessageFromChunk(chunk: StreamChunk): string {
	return typeof chunk.error === "object" &&
		chunk.error !== null &&
		"message" in chunk.error &&
		typeof chunk.error.message === "string"
		? chunk.error.message
		: DEFAULT_ERROR_TEXT;
}

function makeRunErrorSessionEvent(
	runId: string,
	error: unknown,
	onError?: (error: unknown) => string,
): Extract<S2SessionEvent, { kind: "run-error" }> {
	const chunk = makeErrorChunk(error, onError);
	return {
		kind: "run-error",
		runId,
		error: { message: errorMessageFromChunk(chunk) },
		chunk,
		timestamp: nowIso(),
	};
}

export interface S2ConnectionOptions {
	appendUrl: string | (() => string);
	tailUrl: string | (() => string);
	headers?: HeadersInit | (() => HeadersInit);
	fetchClient?: FetchClient;
	streamName?: ConnectionStreamName;
	/**
	 * Sequence number already materialized during SSR/hydration.
	 * Tailing starts at this point after appending a new message.
	 */
	initialSeqNum?: number;
	live?: boolean;
}

export interface S2SessionHandlerConfig extends ResumableGenerationConfig {
	getStream?: (streamName: string) => S2Stream;
	resolveStreamName?: (context: {
		request: Request;
		body?: SessionRequestBody;
	}) => string | Promise<string>;
	selectNewMessages?: (context: {
		body: SessionRequestBody;
		messages: ChatMessage[];
	}) => ChatMessage[];
	produce: (context: {
		request: Request;
		body: SessionRequestBody;
		messages: ChatMessage[];
		newMessages: ChatMessage[];
		data?: Record<string, unknown>;
		streamName: string;
		sessionId?: string;
		runId: string;
		abortSignal: AbortSignal;
	}) => AsyncIterable<StreamChunk> | Promise<AsyncIterable<StreamChunk>>;
}

export interface S2SessionHandler {
	handle(request: Request, options?: MakeResumableOptions): Promise<Response>;
	POST(request: Request, options?: MakeResumableOptions): Promise<Response>;
	GET(request: Request): Promise<Response>;
	snapshot(streamName: string): Promise<S2SessionSnapshot>;
}

function makeErrorChunkRecord(
	err: unknown,
	onError?: (error: unknown) => string,
): AppendRecord {
	return AppendRecord.string({
		body: JSON.stringify(makeErrorChunk(err, onError)),
	});
}

function sseResponseFromSerializedJson(
	source: AsyncIterable<string>,
): Response {
	return sseResponseFromStrings(source, { doneMarker: true });
}

function sseResponseFromStrings(
	source: AsyncIterable<string>,
	{ doneMarker = false }: SseEncodeOptions = {},
): Response {
	const iterator = source[Symbol.asyncIterator]();
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await iterator.next();
				if (next.done) {
					if (doneMarker) {
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					}
					controller.close();
					return;
				}
				controller.enqueue(encoder.encode(`data: ${next.value}\n\n`));
			} catch (err) {
				controller.error(err);
				await iterator.return?.();
			}
		},
		async cancel() {
			await iterator.return?.();
		},
	});
	return new Response(body, { headers: SSE_HEADERS });
}

function jsonSseResponseFromValues<T>(
	source: AsyncIterable<T>,
	options?: SseEncodeOptions,
): Response {
	const strings = (async function* () {
		for await (const value of source) {
			yield JSON.stringify(value);
		}
	})();
	return sseResponseFromStrings(strings, options);
}

function sseDataFromFrame(frame: string): string {
	return frame
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n");
}

async function* readJsonSseStream<T>(
	stream: ReadableStream<Uint8Array> | null,
	{ stopOnDone = false }: SseReadOptions = {},
): AsyncIterable<T> {
	if (!stream) {
		return;
	}
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const emitFrames = function* (frames: string[]): Generator<T, boolean> {
		for (const frame of frames) {
			const data = sseDataFromFrame(frame);
			if (!data) {
				continue;
			}
			if (data === "[DONE]") {
				if (stopOnDone) {
					return true;
				}
				continue;
			}
			yield JSON.parse(data) as T;
		}
		return false;
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			const frames = buffer.split(/\r?\n\r?\n/);
			buffer = frames.pop() ?? "";
			const shouldStop = yield* emitFrames(frames);
			if (shouldStop) {
				return;
			}
			if (done) {
				break;
			}
		}
		if (buffer.trim()) {
			const shouldStop = yield* emitFrames([buffer]);
			if (shouldStop) {
				return;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

async function* readJsonSseResponse<T>(
	response: Response,
	options?: SseReadOptions,
): AsyncIterable<T> {
	yield* readJsonSseStream<T>(response.body, options);
}

function resolveOption<T>(value: T | (() => T)): T {
	return typeof value === "function" ? (value as () => T)() : value;
}

function resolveConnectionStreamName(
	streamName: ConnectionStreamName | undefined,
	messages: ChatMessage[],
	data: Record<string, unknown> | undefined,
): string | undefined {
	return typeof streamName === "function"
		? streamName(messages, data)
		: streamName;
}

function withQueryParams(
	url: string,
	params: Record<string, string | number | boolean | undefined>,
): string {
	const hashStart = url.indexOf("#");
	const beforeHash = hashStart === -1 ? url : url.slice(0, hashStart);
	const hash = hashStart === -1 ? "" : url.slice(hashStart);
	const queryStart = beforeHash.indexOf("?");
	const path = queryStart === -1 ? beforeHash : beforeHash.slice(0, queryStart);
	const query = queryStart === -1 ? "" : beforeHash.slice(queryStart + 1);
	const searchParams = new URLSearchParams(query);

	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			searchParams.set(key, String(value));
		}
	}

	const search = searchParams.toString();
	return `${path}${search ? `?${search}` : ""}${hash}`;
}

function messagesFromBody(body: SessionRequestBody): ChatMessage[] {
	if (body.messages === undefined) {
		return [];
	}
	if (!Array.isArray(body.messages)) {
		throw new Response("messages must be an array", { status: 400 });
	}
	return body.messages;
}

function parseS2AppendResponse(value: unknown): {
	streamName: string;
	runId: string;
	nextSeqNum: number;
} {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("S2 append response must be an object.");
	}
	const body = value as Record<string, unknown>;
	if (
		typeof body.streamName !== "string" ||
		body.streamName.length === 0 ||
		typeof body.runId !== "string" ||
		body.runId.length === 0 ||
		typeof body.nextSeqNum !== "number" ||
		!Number.isSafeInteger(body.nextSeqNum) ||
		body.nextSeqNum < 0
	) {
		throw new TypeError(
			"S2 append response must include streamName, runId, and nextSeqNum.",
		);
	}
	return {
		streamName: body.streamName,
		runId: body.runId,
		nextSeqNum: body.nextSeqNum,
	};
}

function nowIso(): string {
	return new Date().toISOString();
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSelectNewMessages({
	messages,
}: {
	messages: ChatMessage[];
}): ChatMessage[] {
	const latest = messages[messages.length - 1];
	return latest ? [latest] : [];
}

export function encodeS2SessionEvent(event: S2SessionEvent): string {
	return JSON.stringify(event);
}

export function decodeS2SessionEvent(value: string): S2SessionEvent {
	const parsed = JSON.parse(value) as S2SessionEvent;
	if (typeof parsed !== "object" || parsed === null || !("kind" in parsed)) {
		throw new TypeError("S2 session event must be an object.");
	}
	if (
		parsed.kind !== "message" &&
		parsed.kind !== "run-start" &&
		parsed.kind !== "chunk" &&
		parsed.kind !== "run-finish" &&
		parsed.kind !== "run-error"
	) {
		throw new TypeError("Unknown S2 session event kind.");
	}
	return parsed;
}

export function s2SessionEventToRecord(event: S2SessionEvent): AppendRecord {
	return AppendRecord.string({
		body: encodeS2SessionEvent(event),
		headers: [["content-type", SESSION_EVENT_CONTENT_TYPE]],
		timestamp: new Date(event.timestamp),
	});
}

export function readRecordToS2SessionRecord(
	record: ReadRecord<"string">,
): S2SessionRecord {
	return {
		seqNum: record.seqNum,
		timestamp: record.timestamp.toISOString(),
		event: decodeS2SessionEvent(record.body),
	};
}

async function appendS2SessionEvents(
	stream: S2Stream,
	events: ReadonlyArray<S2SessionEvent>,
): Promise<AppendAck> {
	if (events.length === 0) {
		throw new TypeError("appendS2SessionEvents requires events.");
	}
	return await stream.append(
		AppendInput.create(events.map((event) => s2SessionEventToRecord(event))),
	);
}

async function persistS2Run({
	stream,
	runId,
	source,
	onError,
	batchSize,
	lingerDuration,
}: {
	stream: S2Stream;
	runId: string;
	source: AsyncIterable<StreamChunk>;
	onError?: (error: unknown) => string;
	batchSize: number;
	lingerDuration: number;
}): Promise<void> {
	for await (const events of s2RunEventBatches({
		runId,
		source,
		onError,
		batchSize,
		lingerDuration,
	})) {
		await appendS2SessionEvents(stream, events);
	}
}

async function* s2RunEventBatches({
	runId,
	source,
	onError,
	batchSize,
	lingerDuration,
}: {
	runId: string;
	source: AsyncIterable<StreamChunk>;
	onError?: (error: unknown) => string;
	batchSize: number;
	lingerDuration: number;
}): AsyncIterable<ReadonlyArray<S2SessionEvent>> {
	const iterator = source[Symbol.asyncIterator]();
	const maxBatchSize = Math.max(1, batchSize);
	const flushDelay = Math.max(0, lingerDuration);
	let pending: S2SessionEvent[] = [];
	let nextPromise: Promise<IteratorResult<StreamChunk>> | undefined;
	let sourceDone = false;

	const takePending = () => {
		const batch = pending;
		pending = [];
		return batch;
	};

	const nextChunk = () => {
		nextPromise ??= iterator.next();
		return nextPromise;
	};

	const takeNextChunk = async () => {
		const result = await nextChunk();
		nextPromise = undefined;
		return result;
	};

	try {
		while (true) {
			let result: IteratorResult<StreamChunk>;
			if (pending.length === 0 || flushDelay === 0) {
				result = await takeNextChunk();
			} else {
				const next = await Promise.race([
					nextChunk().then((result) => ({ type: "next" as const, result })),
					delay(flushDelay).then(() => ({ type: "flush" as const })),
				]);
				if (next.type === "flush") {
					yield takePending();
					continue;
				}
				nextPromise = undefined;
				result = next.result;
			}

			if (result.done) {
				sourceDone = true;
				break;
			}

			pending.push({
				kind: "chunk",
				runId,
				chunk: result.value,
				timestamp: nowIso(),
			});
			if (pending.length >= maxBatchSize || flushDelay === 0) {
				yield takePending();
			}
		}

		pending.push({ kind: "run-finish", runId, timestamp: nowIso() });
		yield takePending();
	} catch (error) {
		pending.push(makeRunErrorSessionEvent(runId, error, onError));
		yield takePending();
		throw error;
	} finally {
		if (!sourceDone) {
			await iterator.return?.().catch(() => {});
		}
	}
}

async function* readS2SessionEventsFromStream({
	stream,
	fromSeqNum = 0,
	live = true,
	batchSize = DEFAULT_SESSION_READ_BATCH_SIZE,
}: {
	stream: S2Stream;
	fromSeqNum?: number;
	live?: boolean;
	batchSize?: number;
}): AsyncIterable<S2SessionRecord> {
	if (live) {
		const session = await stream.readSession(
			{
				start: { from: { seqNum: fromSeqNum }, clamp: true },
				ignoreCommandRecords: true,
			},
			{ as: "string" },
		);
		try {
			for await (const record of session) {
				yield readRecordToS2SessionRecord(record);
			}
		} finally {
			await session[Symbol.asyncDispose]?.();
		}
		return;
	}

	let nextSeqNum = fromSeqNum;
	const { tail } = await stream.checkTail();
	while (nextSeqNum < tail.seqNum) {
		const batch = await stream.read(
			{
				start: { from: { seqNum: nextSeqNum }, clamp: true },
				stop: { limits: { count: batchSize } },
				ignoreCommandRecords: true,
			},
			{ as: "string" },
		);
		if (batch.records.length === 0) {
			break;
		}
		for (const record of batch.records) {
			yield readRecordToS2SessionRecord(record);
		}
		const last = batch.records[batch.records.length - 1]!;
		nextSeqNum = last.seqNum + 1;
	}
}

export function sessionRecordsToSseResponse(
	source: AsyncIterable<S2SessionRecord>,
): Response {
	return jsonSseResponseFromValues(source);
}

export async function* readS2SessionSseResponse(
	response: Response,
): AsyncIterable<S2SessionRecord> {
	yield* readJsonSseResponse<S2SessionRecord>(response);
}

function materializeMessagesFromEvents(
	events: ReadonlyArray<S2SessionRecord>,
): ChatMessage[] {
	const messages: ChatMessage[] = [];
	const assistantByMessageId = new Map<string, ChatMessage>();

	for (const { event } of events) {
		if (event.kind === "message") {
			messages.push(event.message);
			continue;
		}
		if (event.kind !== "chunk") {
			continue;
		}

		const chunk = event.chunk;
		const messageId =
			typeof chunk.messageId === "string" ? chunk.messageId : event.runId;

		if (chunk.type === "TEXT_MESSAGE_START") {
			const message: ChatMessage = {
				id: messageId,
				role: typeof chunk.role === "string" ? chunk.role : "assistant",
				content: "",
			};
			assistantByMessageId.set(messageId, message);
			messages.push(message);
			continue;
		}

		if (chunk.type === "TEXT_MESSAGE_CONTENT") {
			const message =
				assistantByMessageId.get(messageId) ??
				({
					id: messageId,
					role: "assistant",
					content: "",
				} satisfies ChatMessage);
			if (!assistantByMessageId.has(messageId)) {
				assistantByMessageId.set(messageId, message);
				messages.push(message);
			}
			if (typeof chunk.delta === "string") {
				message.content = `${String(message.content ?? "")}${chunk.delta}`;
			}
		}
	}

	return messages;
}

export async function materializeSessionSnapshot({
	stream,
	start,
	batchSize = DEFAULT_SESSION_READ_BATCH_SIZE,
}: {
	stream: S2Stream;
	start?: ReadInput["start"];
	batchSize?: number;
}): Promise<S2SessionSnapshot> {
	const from = start?.from;
	const fromSeqNum = from && "seqNum" in from ? from.seqNum : 0;
	const { tail } = await stream.checkTail();
	const events: S2SessionRecord[] = [];
	for await (const event of readS2SessionEventsFromStream({
		stream,
		fromSeqNum,
		live: false,
		batchSize,
	})) {
		events.push(event);
	}
	return {
		messages: materializeMessagesFromEvents(events),
		events,
		nextSeqNum: tail.seqNum,
		tail,
	};
}

export async function* readSseStream(
	stream: ReadableStream<Uint8Array> | null,
): AsyncIterable<StreamChunk> {
	yield* readJsonSseStream<StreamChunk>(stream, {
		stopOnDone: true,
	});
}

export async function* readSseResponse(
	response: Response,
): AsyncIterable<StreamChunk> {
	yield* readSseStream(response.body);
}

export function createHttpConnection(
	options: HttpConnectionOptions,
): Connection {
	const fetchClient = options.fetchClient ?? fetch;
	return {
		connect(messages, data, abortSignal) {
			return (async function* () {
				const streamName = resolveConnectionStreamName(
					options.streamName,
					messages,
					data,
				);
				const response = await fetchClient(resolveOption(options.url), {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...resolveOption(options.headers ?? {}),
					},
					body: JSON.stringify({ messages, data, streamName }),
					signal: abortSignal,
				});
				if (!response.ok) {
					throw new Error(
						`TanStack AI stream request failed: ${response.status}`,
					);
				}
				yield* readSseResponse(response);
			})();
		},
	};
}

export function replayHttpConnection(
	options: Omit<HttpConnectionOptions, "streamName"> & {
		streamName: string;
	},
): AsyncIterable<StreamChunk> {
	const fetchClient = options.fetchClient ?? fetch;
	return (async function* () {
		const response = await fetchClient(
			withQueryParams(resolveOption(options.url), {
				streamName: options.streamName,
			}),
			{
				method: "GET",
				headers: resolveOption(options.headers ?? {}),
			},
		);
		if (response.status === 204) {
			return;
		}
		if (!response.ok) {
			throw new Error(`TanStack AI replay request failed: ${response.status}`);
		}
		yield* readSseResponse(response);
	})();
}

export function createS2Connection(options: S2ConnectionOptions): Connection {
	const fetchClient = options.fetchClient ?? fetch;
	return {
		connect(messages, data, abortSignal) {
			return (async function* () {
				const streamName = resolveConnectionStreamName(
					options.streamName,
					messages,
					data,
				);
				const appendResponse = await fetchClient(
					resolveOption(options.appendUrl),
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							...resolveOption(options.headers ?? {}),
						},
						body: JSON.stringify({ messages, data, streamName }),
						signal: abortSignal,
					},
				);
				if (!appendResponse.ok) {
					throw new Error(
						`S2 TanStack AI session append failed: ${appendResponse.status}`,
					);
				}

				const appendAck = parseS2AppendResponse(await appendResponse.json());
				const fromSeqNum = options.initialSeqNum ?? appendAck.nextSeqNum;
				const tailUrl = withQueryParams(resolveOption(options.tailUrl), {
					streamName: appendAck.streamName,
					fromSeqNum,
					live: options.live ?? true,
				});
				const tailResponse = await fetchClient(tailUrl, {
					method: "GET",
					headers: resolveOption(options.headers ?? {}),
					signal: abortSignal,
				});
				if (tailResponse.status === 204) {
					return;
				}
				if (!tailResponse.ok) {
					throw new Error(
						`S2 TanStack AI session tail failed: ${tailResponse.status}`,
					);
				}

				for await (const record of readS2SessionSseResponse(tailResponse)) {
					const event = record.event;
					if (event.kind === "chunk" && event.runId === appendAck.runId) {
						yield event.chunk;
					}
					if (
						(event.kind === "run-finish" || event.kind === "run-error") &&
						event.runId === appendAck.runId
					) {
						if (event.kind === "run-error") {
							yield event.chunk;
						}
						return;
					}
				}
			})();
		},
	};
}

export function streamToSseResponse(
	source: AsyncIterable<StreamChunk>,
): Response {
	return jsonSseResponseFromValues(source, { doneMarker: true });
}

/**
 * Creates server-side helpers for making TanStack AI streams resumable in S2.
 */
export function createResumableGeneration(
	config: ResumableGenerationConfig,
): ResumableGeneration {
	const s2 = new S2({
		accessToken: config.accessToken,
		endpoints: config.endpoints,
	});
	const basin = config.basin;
	const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
	const lingerDuration = config.lingerDuration ?? DEFAULT_LINGER_DURATION;
	const streamReuse = config.streamReuse ?? "single-use";
	const leaseDurationMs = config.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
	const onError = config.onError;

	const makeResumable = async (
		streamName: string,
		source: AsyncIterable<StreamChunk>,
		options?: MakeResumableOptions,
	): Promise<Response> => {
		const fencingToken = `session-${randomToken(8)}`;
		let matchSeqNumStart = 1;

		try {
			if (streamReuse === "shared") {
				const claim = await claimSharedGeneration({
					s2,
					basin,
					stream: streamName,
					fencingToken,
					leaseDurationMs,
				});
				if (!claim) {
					return new Response("Stream already in use", { status: 409 });
				}
				matchSeqNumStart = claim.matchSeqNumStart;
			} else {
				const ack = await appendFenceCommand(
					s2,
					basin,
					streamName,
					"",
					fencingToken,
					{ matchSeqNum: 0 },
				);
				matchSeqNumStart = ack.end.seqNum;
			}
		} catch (err) {
			if (
				err instanceof FencingTokenMismatchError ||
				err instanceof SeqNumMismatchError
			) {
				return new Response("Stream already in use", { status: 409 });
			}
			throw err;
		}

		const [toClient, toPersist] = asyncIterableToReadableStream(source).tee();

		const persistPromise = persistToS2({
			s2,
			basin,
			stream: streamName,
			source: readableToAsyncIterable(toPersist),
			fencingToken,
			batchSize,
			lingerDuration,
			matchSeqNumStart,
			toRecord: (chunk) => AppendRecord.string({ body: JSON.stringify(chunk) }),
			finalRecords: (sourceError) => {
				const fenceToken =
					sourceError !== undefined
						? `error-${randomToken(4)}`
						: `end-${randomToken(4)}`;
				const records: AppendRecord[] =
					sourceError !== undefined
						? [
								makeErrorChunkRecord(sourceError, onError),
								AppendRecord.fence(fenceToken),
							]
						: [AppendRecord.fence(fenceToken)];
				if (streamReuse === "single-use") {
					records.push(AppendRecord.trim(Number.MAX_SAFE_INTEGER));
				}
				return records;
			},
		});

		if (options?.waitUntil) {
			options.waitUntil(persistPromise);
		} else {
			persistPromise.catch((err) => {
				console.error(
					"[resumable-stream/tanstack-ai] Background persist failed:",
					err,
				);
			});
		}

		return streamToSseResponse(readableToAsyncIterable(toClient));
	};

	return {
		makeResumable,

		async replay(streamName: string): Promise<Response> {
			const iterator = replayActiveGenerationStringBodies({
				s2,
				basin,
				stream: streamName,
			})[Symbol.asyncIterator]();
			const first = await iterator.next();
			if (first.done) {
				return new Response(null, {
					status: 204,
					headers: { "Cache-Control": "no-store" },
				});
			}

			const replayWithFirst = (async function* () {
				yield first.value;
				for await (const value of {
					[Symbol.asyncIterator]: () => iterator,
				}) {
					yield value;
				}
			})();
			return sseResponseFromSerializedJson(replayWithFirst);
		},
	};
}

async function defaultResolveStreamName({
	request,
	body,
}: {
	request: Request;
	body?: SessionRequestBody;
}): Promise<string> {
	const url = new URL(request.url);
	const streamName =
		body?.streamName ??
		body?.sessionId ??
		url.searchParams.get("streamName") ??
		url.searchParams.get("sessionId");
	if (!streamName) {
		throw new Response("Missing streamName or sessionId", { status: 400 });
	}
	return streamName;
}

export function createHttpSessionHandler(
	config: HttpSessionHandlerConfig,
): HttpSessionHandler {
	const resumable = createResumableGeneration(config);
	const resolveStreamName =
		config.resolveStreamName ?? defaultResolveStreamName;

	const GET = async (request: Request): Promise<Response> => {
		try {
			const streamName = await resolveStreamName({ request });
			return await resumable.replay(streamName);
		} catch (error) {
			if (error instanceof Response) {
				return error;
			}
			throw error;
		}
	};

	const POST = async (
		request: Request,
		options?: MakeResumableOptions,
	): Promise<Response> => {
		let body: SessionRequestBody;
		try {
			body = (await request.json()) as SessionRequestBody;
		} catch {
			return new Response("Expected JSON request body", { status: 400 });
		}

		try {
			const streamName = await resolveStreamName({ request, body });
			const messages = messagesFromBody(body);
			const source = await config.produce({
				request,
				body,
				messages,
				data: body.data,
				streamName,
				sessionId: body.sessionId,
				abortSignal: request.signal,
			});
			return await resumable.makeResumable(streamName, source, options);
		} catch (error) {
			if (error instanceof Response) {
				return error;
			}
			throw error;
		}
	};

	return {
		handle(request, options) {
			if (request.method === "GET") {
				return GET(request);
			}
			if (request.method === "POST") {
				return POST(request, options);
			}
			return Promise.resolve(
				new Response("Method not allowed", { status: 405 }),
			);
		},
		POST,
		GET,
		replay: resumable.replay,
	};
}

function parseSeqNum(value: string | null): number {
	if (value === null || value === "") {
		return 0;
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Response("Invalid fromSeqNum", { status: 400 });
	}
	return parsed;
}

export function createS2SessionHandler(
	config: S2SessionHandlerConfig,
): S2SessionHandler {
	const s2 = config.getStream
		? undefined
		: new S2({
				accessToken: config.accessToken,
				endpoints: config.endpoints,
			});
	const getStream =
		config.getStream ??
		((streamName: string) => s2!.basin(config.basin).stream(streamName));
	const resolveStreamName =
		config.resolveStreamName ?? defaultResolveStreamName;
	const selectNewMessages =
		config.selectNewMessages ?? defaultSelectNewMessages;
	const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
	const lingerDuration = config.lingerDuration ?? DEFAULT_LINGER_DURATION;

	const POST = async (
		request: Request,
		options?: MakeResumableOptions,
	): Promise<Response> => {
		let body: SessionRequestBody;
		try {
			body = (await request.json()) as SessionRequestBody;
		} catch {
			return new Response("Expected JSON request body", { status: 400 });
		}

		try {
			const streamName = await resolveStreamName({ request, body });
			const stream = getStream(streamName);
			const messages = messagesFromBody(body);
			const newMessages = selectNewMessages({ body, messages });
			const runId =
				typeof body.runId === "string" ? body.runId : `run-${randomToken(8)}`;
			const timestamp = nowIso();
			const startEvents: S2SessionEvent[] = [
				...newMessages.map((message) => ({
					kind: "message" as const,
					message,
					messageId: typeof message.id === "string" ? message.id : undefined,
					runId,
					timestamp,
				})),
				{
					kind: "run-start",
					runId,
					data: body.data,
					timestamp,
				},
			];

			const ack = await appendS2SessionEvents(stream, startEvents);
			const appendAcceptedResponse = (tail: StreamPosition) =>
				Response.json(
					{
						streamName,
						runId,
						startSeqNum: ack.start.seqNum,
						nextSeqNum: ack.end.seqNum,
						tail,
					},
					{ status: 202 },
				);

			let source: AsyncIterable<StreamChunk>;
			try {
				source = await config.produce({
					request,
					body,
					messages,
					newMessages,
					data: body.data,
					streamName,
					sessionId: body.sessionId,
					runId,
					abortSignal: request.signal,
				});
			} catch (error) {
				const errorAck = await appendS2SessionEvents(stream, [
					makeRunErrorSessionEvent(runId, error, config.onError),
				]);
				return appendAcceptedResponse(errorAck.tail);
			}

			const persistPromise = persistS2Run({
				stream,
				runId,
				source,
				onError: config.onError,
				batchSize,
				lingerDuration,
			});

			if (options?.waitUntil) {
				options.waitUntil(persistPromise);
			} else {
				persistPromise.catch((error) => {
					console.error(
						"[resumable-stream/tanstack-ai] Session persist failed:",
						error,
					);
				});
			}

			return appendAcceptedResponse(ack.tail);
		} catch (error) {
			if (error instanceof Response) {
				return error;
			}
			throw error;
		}
	};

	const GET = async (request: Request): Promise<Response> => {
		try {
			const url = new URL(request.url);
			const streamName = await resolveStreamName({ request });
			const fromSeqNum = parseSeqNum(
				url.searchParams.get("fromSeqNum") ?? url.searchParams.get("offset"),
			);
			const live = url.searchParams.get("live") !== "false";
			const stream = getStream(streamName);
			return jsonSseResponseFromValues(
				readS2SessionEventsFromStream({
					stream,
					fromSeqNum,
					live,
				}),
			);
		} catch (error) {
			if (error instanceof Response) {
				return error;
			}
			throw error;
		}
	};

	return {
		handle(request, options) {
			if (request.method === "GET") {
				return GET(request);
			}
			if (request.method === "POST") {
				return POST(request, options);
			}
			return Promise.resolve(
				new Response("Method not allowed", { status: 405 }),
			);
		},
		POST,
		GET,
		snapshot(streamName) {
			return materializeSessionSnapshot({
				stream: getStream(streamName),
			});
		},
	};
}
