/**
 * Client-side connection adapter for TanStack AI's `ChatClient` / `useChat`,
 * wired to a `@s2-dev/resumable-stream/tanstack-ai` server.
 *
 * Auto-picks the adapter shape per server mode:
 * - `single-use` / `shared`: returns a `ConnectConnectionAdapter` by default.
 *   If `subscribeUrl` is provided, returns a `SubscribeConnectionAdapter` so
 *   refreshes can reconnect through the replay route.
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
import {
	fetchOk,
	type HeadersOption,
	pipeSseFrames,
	resolveCursorUrl,
	resolveHeaders,
	resolveUrl,
} from "./client-utils.js";

export type { ConnectionAdapter } from "@tanstack/ai-client";

type Messages = ReadonlyArray<UIMessage> | ReadonlyArray<ModelMessage>;

export type S2ConnectionMode = "single-use" | "shared" | "session";

export interface S2ConnectionOptions {
	/** Endpoint that POSTs messages and starts a generation. */
	sendUrl: string | (() => string);
	/** Endpoint that stops the active generation. Optional. */
	stopUrl?: string | (() => string);
	/**
	 * Endpoint that GETs the SSE chunk stream. Required for `session`.
	 * In `single-use` and `shared`, passing this opts into subscribe/send mode.
	 */
	subscribeUrl?: string | ((cursor?: number) => string);
	/** Server mode. Drives which adapter shape is returned. Defaults to `single-use`. */
	mode?: S2ConnectionMode;
	/** Extra headers added to both fetches. May be a (possibly async) factory. */
	headers?: HeadersOption;
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

export type S2Connection = ConnectionAdapter & {
	/** Stops the active server-side generation when `stopUrl` is configured. */
	stop?: () => Promise<void>;
};

async function* parseSseChunks(
	body: ReadableStream<Uint8Array>,
	abortSignal?: AbortSignal,
	onEventId?: (id: string) => void,
): AsyncGenerator<StreamChunk> {
	for await (const frame of pipeSseFrames(body, abortSignal)) {
		if (frame.id) onEventId?.(frame.id);
		// `[DONE]` is the OpenAI convention; harmless on streams that omit it.
		if (!frame.data || frame.data === "[DONE]") continue;
		try {
			yield JSON.parse(frame.data) as StreamChunk;
		} catch {
			// Skip malformed JSON frames so the stream can continue.
		}
	}
}

async function discardBody(body: ReadableStream<Uint8Array>): Promise<void> {
	// The replay subscription owns delivery; ignore best-effort body cleanup.
	await body.cancel().catch(() => {});
}

function makeSyntheticRunFinished(): StreamChunk {
	return {
		type: "RUN_FINISHED",
		runId: `s2-replay-${Date.now()}`,
		model: "s2-replay",
		timestamp: Date.now(),
		finishReason: "stop",
	} as StreamChunk;
}

function createChunkQueue(abortSignal?: AbortSignal) {
	let buffer: StreamChunk[] = [];
	let waiters: Array<{
		resolve: (value: IteratorResult<StreamChunk>) => void;
		reject: (error: unknown) => void;
	}> = [];
	let closed = false;
	let failure: unknown;

	const flush = () => {
		while (waiters.length > 0 && (buffer.length > 0 || closed || failure)) {
			const waiter = waiters.shift()!;
			if (failure) {
				waiter.reject(failure);
			} else if (buffer.length > 0) {
				waiter.resolve({ done: false, value: buffer.shift()! });
			} else {
				waiter.resolve({ done: true, value: undefined });
			}
		}
	};

	const close = () => {
		if (closed) return;
		closed = true;
		flush();
	};

	abortSignal?.addEventListener("abort", close, { once: true });

	return {
		push(chunk: StreamChunk): void {
			if (closed || failure) return;
			buffer.push(chunk);
			flush();
		},
		fail(error: unknown): void {
			if (closed || failure) return;
			failure = error;
			flush();
		},
		async *iterable(): AsyncIterable<StreamChunk> {
			try {
				while (true) {
					if (buffer.length > 0) {
						yield buffer.shift()!;
						continue;
					}
					if (failure) throw failure;
					if (closed) return;
					const next = await new Promise<IteratorResult<StreamChunk>>(
						(resolve, reject) => waiters.push({ resolve, reject }),
					);
					if (next.done) return;
					yield next.value;
				}
			} finally {
				abortSignal?.removeEventListener("abort", close);
				close();
			}
		},
	};
}

/** Build the chat connection adapter. */
export function createS2Connection(options: S2ConnectionOptions): S2Connection {
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
		return fetchOk(doFetch, resolveUrl(options.sendUrl), {
			method: "POST",
			headers,
			body: JSON.stringify(buildBody(messages, data)),
			credentials,
			signal: abortSignal,
		});
	};

	const stop = options.stopUrl
		? async (): Promise<void> => {
				const headers = {
					"Content-Type": "application/json",
					...(await resolveHeaders(options.headers)),
				};
				await fetchOk(doFetch, resolveUrl(options.stopUrl!), {
					method: "DELETE",
					headers,
					body: JSON.stringify(buildBody([], undefined)),
					credentials,
				});
			}
		: undefined;

	if (options.subscribeUrl) {
		const subscribeUrl = options.subscribeUrl as
			| string
			| ((cursor?: number) => string);
		let nextCursor: number | undefined;
		const updateCursor = (id: string) => {
			if (!/^\d+$/.test(id)) return;
			const parsed = Number.parseInt(id, 10);
			if (!Number.isSafeInteger(parsed) || parsed < 0) return;
			if (nextCursor === undefined || parsed > nextCursor) {
				nextCursor = parsed;
			}
		};

		if (mode !== "session") {
			let activeQueue: ReturnType<typeof createChunkQueue> | undefined;

			const adapter: SubscribeConnectionAdapter = {
				subscribe(abortSignal?: AbortSignal): AsyncIterable<StreamChunk> {
					const queue = createChunkQueue(abortSignal);
					activeQueue = queue;

					void (async () => {
						try {
							const headers = await resolveHeaders(options.headers);
							const response = await fetchOk(
								doFetch,
								resolveCursorUrl(subscribeUrl, nextCursor),
								{
									method: "GET",
									headers,
									credentials,
									signal: abortSignal,
								},
							);
							if (!response.body) return;
							for await (const chunk of parseSseChunks(
								response.body,
								abortSignal,
								updateCursor,
							)) {
								queue.push(chunk);
							}
						} catch (error) {
							if (!abortSignal?.aborted) queue.fail(error);
						}
					})();

					return queue.iterable();
				},
				async send(messages, data, abortSignal): Promise<void> {
					const response = await postSend(messages, data, abortSignal);
					if (!response.body) return;
					for await (const chunk of parseSseChunks(
						response.body,
						abortSignal,
						updateCursor,
					)) {
						activeQueue?.push(chunk);
					}
				},
			};
			return stop ? { ...adapter, stop } : adapter;
		}

		const adapter: SubscribeConnectionAdapter = {
			async *subscribe(abortSignal?: AbortSignal): AsyncIterable<StreamChunk> {
				const headers = await resolveHeaders(options.headers);
				const response = await fetchOk(
					doFetch,
					resolveCursorUrl(subscribeUrl, nextCursor),
					{
						method: "GET",
						headers,
						credentials,
						signal: abortSignal,
					},
				);
				if (!response.body) {
					// TanStack waits for a terminal chunk after send(); 204 replay
					// responses mean there is nothing active to consume.
					yield makeSyntheticRunFinished();
					return;
				}
				yield* parseSseChunks(response.body, abortSignal, updateCursor);
			},
			async send(messages, data, abortSignal): Promise<void> {
				const response = await postSend(messages, data, abortSignal);
				if (response.body) await discardBody(response.body);
			},
		};
		return stop ? { ...adapter, stop } : adapter;
	}

	const adapter: ConnectConnectionAdapter = {
		async *connect(messages, data, abortSignal): AsyncIterable<StreamChunk> {
			const response = await postSend(messages, data, abortSignal);
			if (!response.body) return;
			yield* parseSseChunks(response.body, abortSignal);
		},
	};
	return stop ? { ...adapter, stop } : adapter;
}
