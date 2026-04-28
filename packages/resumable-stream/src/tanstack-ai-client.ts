/**
 * Client-side connection adapter for TanStack AI's `ChatClient` / `useChat`,
 * wired to a `@s2-dev/resumable-stream/tanstack-ai` server.
 *
 * Auto-picks the adapter shape per server mode:
 * - `single-use` / `shared`: returns a `ConnectConnectionAdapter` that POSTs
 *   to `sendUrl` and yields chunks from the live SSE response.
 * - `session`: returns a `SubscribeConnectionAdapter` that GETs `subscribeUrl`
 *   to tail the stream forever, and POSTs to `sendUrl` to kick off generations.
 *
 * Types come from `@tanstack/ai` and `@tanstack/ai-client` (type-only imports;
 * no runtime dependency). Both are declared as optional peer dependencies.
 */
import type { ModelMessage, StreamChunk, UIMessage } from "@tanstack/ai";
import type {
	ConnectConnectionAdapter,
	ConnectionAdapter,
	SubscribeConnectionAdapter,
} from "@tanstack/ai-client";
import { EventSourceParserStream } from "eventsource-parser/stream";

export type { ConnectionAdapter } from "@tanstack/ai-client";

type Messages = ReadonlyArray<UIMessage> | ReadonlyArray<ModelMessage>;

export type S2ConnectionMode = "single-use" | "shared" | "session";

export type ChatSnapshot = {
	messages: UIMessage[];
	fromSeqNum: number;
};

export interface LoadSnapshotOptions {
	/** Endpoint that returns `{ messages, fromSeqNum }`. */
	url: string | (() => string);
	/** Extra headers added to the snapshot fetch. May be a factory. */
	headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
	/** Custom fetch (testing, custom auth). Defaults to `globalThis.fetch`. */
	fetch?: typeof fetch;
	/** Forwarded to fetch. Defaults to `same-origin`. */
	credentials?: RequestCredentials;
}

export interface S2ConnectionOptions {
	/** Endpoint that POSTs messages and starts a generation. */
	sendUrl: string | (() => string);
	/** Endpoint that GETs the SSE chunk stream. Required for `session`. */
	subscribeUrl?: string | ((fromSeqNum?: number) => string);
	/** Server mode. Drives which adapter shape is returned. Defaults to `single-use`. */
	mode?: S2ConnectionMode;
	/**
	 * Starting cursor for `session` subscriptions. Snapshot responses should
	 * pass the next S2 sequence number here so subscribe only reads new records.
	 */
	initialFromSeqNum?: number;
	/**
	 * Snapshot loaded before constructing the connection. For `session`,
	 * this is the concise way to seed the reconnect cursor.
	 */
	snapshot?: ChatSnapshot;
	/**
	 * Query parameter used to add the live cursor when `subscribeUrl` is a
	 * string. Set to `false` when the URL already embeds its own cursor.
	 *
	 * @default "from"
	 */
	fromSeqNumParam?: string | false;
	/** Extra headers added to both fetches. May be a (possibly async) factory. */
	headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
	/**
	 * Extra fields merged into the POST body. May be a function of the messages
	 * and data being sent. The base body always carries `{ messages, data }`.
	 */
	body?:
		| Record<string, unknown>
		| ((
				messages: Messages,
				data?: Record<string, unknown>,
		  ) => Record<string, unknown>);
	/** Custom fetch (testing, custom auth). Defaults to `globalThis.fetch`. */
	fetch?: typeof fetch;
	/** Forwarded to fetch. Defaults to `same-origin`. */
	credentials?: RequestCredentials;
}

async function resolveHeaders(
	headers: S2ConnectionOptions["headers"],
): Promise<Record<string, string>> {
	if (!headers) return {};
	const resolved = typeof headers === "function" ? await headers() : headers;
	if (resolved instanceof Headers) {
		return Object.fromEntries(resolved.entries());
	}
	if (Array.isArray(resolved)) {
		return Object.fromEntries(resolved);
	}
	return { ...resolved };
}

function resolveUrl(url: string | (() => string)): string {
	return typeof url === "function" ? url() : url;
}

function resolveSubscribeUrl(
	url: string | ((fromSeqNum?: number) => string),
	fromSeqNum: number | undefined,
	fromSeqNumParam: string | false,
): string {
	if (typeof url === "function") return url(fromSeqNum);
	if (fromSeqNum === undefined || fromSeqNumParam === false) return url;

	const parsed = new URL(url, "http://s2.local");
	parsed.searchParams.set(fromSeqNumParam, String(fromSeqNum));
	if (/^[a-z][a-z\d+\-.]*:/i.test(url)) return parsed.toString();
	return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function decodeBytesToText(): TransformStream<Uint8Array, string> {
	const decoder = new TextDecoder();
	return new TransformStream({
		transform(chunk, controller) {
			controller.enqueue(decoder.decode(chunk, { stream: true }));
		},
		flush(controller) {
			const tail = decoder.decode();
			if (tail) controller.enqueue(tail);
		},
	});
}

async function* parseSseChunks(
	body: ReadableStream<Uint8Array>,
	abortSignal?: AbortSignal,
	onEventId?: (id: string) => void,
): AsyncGenerator<StreamChunk> {
	const events = body
		.pipeThrough(decodeBytesToText())
		.pipeThrough(new EventSourceParserStream());
	const reader = events.getReader();
	try {
		while (true) {
			if (abortSignal?.aborted) return;
			const { done, value } = await reader.read();
			if (done) return;
			if (value?.id) onEventId?.(value.id);
			const data = value?.data;
			if (!data || data === "[DONE]") continue;
			try {
				yield JSON.parse(data) as StreamChunk;
			} catch {
				// Skip malformed JSON frames so the stream can continue.
			}
		}
	} finally {
		reader.releaseLock();
	}
}

async function readResponse(
	doFetch: typeof fetch,
	url: string,
	init: RequestInit,
): Promise<Response> {
	const response = await doFetch(url, init);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
	}
	return response;
}

function normalizeSnapshot(value: unknown): ChatSnapshot {
	const payload = isRecord(value) ? value : {};
	const fromSeqNum = payload.fromSeqNum;
	return {
		messages: Array.isArray(payload.messages)
			? (payload.messages as UIMessage[])
			: [],
		fromSeqNum:
			typeof fromSeqNum === "number" && Number.isSafeInteger(fromSeqNum)
				? fromSeqNum
				: 0,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Load a session snapshot before creating the TanStack connection. */
export async function loadSnapshot(
	options: LoadSnapshotOptions,
): Promise<ChatSnapshot> {
	const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	const response = await readResponse(doFetch, resolveUrl(options.url), {
		method: "GET",
		headers: await resolveHeaders(options.headers),
		credentials: options.credentials ?? "same-origin",
	});
	return normalizeSnapshot(await response.json());
}

/** Build the chat connection adapter. */
export function createS2Connection(
	options: S2ConnectionOptions,
): ConnectionAdapter {
	const mode = options.mode ?? "single-use";
	const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	const credentials = options.credentials ?? "same-origin";

	if (mode === "session" && !options.subscribeUrl) {
		throw new Error(
			'createS2Connection: subscribeUrl is required when mode is "session"',
		);
	}

	const buildBody = (
		messages: Messages,
		data: Record<string, unknown> | undefined,
	): Record<string, unknown> => {
		const extra =
			typeof options.body === "function"
				? options.body(messages, data)
				: (options.body ?? {});
		return { messages, data, ...extra };
	};

	const postSend = async (
		messages: Messages,
		data: Record<string, unknown> | undefined,
		abortSignal: AbortSignal | undefined,
	): Promise<Response> => {
		const headers = {
			"Content-Type": "application/json",
			...(await resolveHeaders(options.headers)),
		};
		return readResponse(doFetch, resolveUrl(options.sendUrl), {
			method: "POST",
			headers,
			body: JSON.stringify(buildBody(messages, data)),
			credentials,
			signal: abortSignal,
		});
	};

	if (mode === "session") {
		const subscribeUrl = options.subscribeUrl as
			| string
			| ((fromSeqNum?: number) => string);
		const fromSeqNumParam = options.fromSeqNumParam ?? "from";
		const initialFromSeqNum =
			options.snapshot?.fromSeqNum ?? options.initialFromSeqNum;
		let nextFromSeqNum =
			typeof initialFromSeqNum === "number" &&
			Number.isSafeInteger(initialFromSeqNum)
				? initialFromSeqNum
				: undefined;
		const updateCursor = (id: string) => {
			if (!/^\d+$/.test(id)) return;
			const parsed = Number.parseInt(id, 10);
			if (!Number.isSafeInteger(parsed) || parsed < 0) return;
			if (nextFromSeqNum === undefined || parsed > nextFromSeqNum) {
				nextFromSeqNum = parsed;
			}
		};
		const adapter: SubscribeConnectionAdapter = {
			async *subscribe(abortSignal?: AbortSignal): AsyncIterable<StreamChunk> {
				const headers = await resolveHeaders(options.headers);
				const response = await readResponse(
					doFetch,
					resolveSubscribeUrl(subscribeUrl, nextFromSeqNum, fromSeqNumParam),
					{
						method: "GET",
						headers,
						credentials,
						signal: abortSignal,
					},
				);
				if (!response.body) return;
				yield* parseSseChunks(response.body, abortSignal, updateCursor);
			},
			async send(messages, data, abortSignal): Promise<void> {
				await postSend(messages, data, abortSignal);
			},
		};
		return adapter;
	}

	const adapter: ConnectConnectionAdapter = {
		async *connect(messages, data, abortSignal): AsyncIterable<StreamChunk> {
			const response = await postSend(messages, data, abortSignal);
			if (!response.body) return;
			yield* parseSseChunks(response.body, abortSignal);
		},
	};
	return adapter;
}
