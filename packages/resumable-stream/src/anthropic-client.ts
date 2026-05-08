/**
 * Client-side helpers for consuming a `@s2-dev/resumable-stream/anthropic`
 * server. Mirrors the shape of `./tanstack-ai-client` but tailored to
 * Anthropic-native SSE.
 *
 * The wire format is `event: <type>\ndata: <json>\nid: <seq>\n\n`, so we use
 * `EventSourceParserStream` and JSON-decode each `data` payload back into a
 * `RawMessageStreamEvent`. Cursor tracking via the SSE `id:` line lets a
 * subsequent `subscribe()` call continue from the last record seen on a drop.
 */
import type {
	Message,
	RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import { EventSourceParserStream } from "eventsource-parser/stream";
import {
	type AnthropicAccumulator,
	createAnthropicAccumulator,
} from "./anthropic-accumulator.js";

/**
 * The Anthropic API also emits `error` events at the SSE wire level; surface
 * them here so consumers can react.
 */
export type AnthropicWireEvent =
	| RawMessageStreamEvent
	| {
			type: "error";
			error: { type: string; message: string };
	  };

export interface S2AnthropicChatOptions {
	/** Endpoint that POSTs the request body and starts a generation. */
	sendUrl: string | (() => string);
	/** Endpoint that GETs the SSE replay stream. Reconnect uses `?from=<cursor>`. */
	subscribeUrl: string | ((cursor?: number) => string);
	/** Optional: endpoint that returns `{ messages: Message[] }` JSON. */
	historyUrl?: string | (() => string);
	/** Optional: endpoint that stops the active generation (DELETE). */
	stopUrl?: string | (() => string);
	/** Custom fetch (testing, custom auth). Defaults to `globalThis.fetch`. */
	fetch?: typeof fetch;
	/** Extra headers added to every fetch. May be a (possibly async) factory. */
	headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
	/** Forwarded to fetch. Defaults to `same-origin`. */
	credentials?: RequestCredentials;
}

export interface S2AnthropicSubscription {
	/** Async iterator of wire events as they arrive. */
	events: AsyncIterable<AnthropicWireEvent>;
	/**
	 * Resolves with the accumulated `Message` for the next turn that ends in
	 * `message_stop`. Rejects if the stream ends or errors before then.
	 */
	nextMessage(): Promise<Message>;
	/** Aborts the in-flight subscription. */
	cancel(): void;
}

export interface S2AnthropicChat {
	/** POSTs to `sendUrl` and returns a subscription over the response body. */
	send(
		body: unknown,
		opts?: { signal?: AbortSignal },
	): Promise<S2AnthropicSubscription>;
	/** GETs the replay endpoint, continuing from the last seen cursor. */
	subscribe(opts?: { signal?: AbortSignal }): Promise<S2AnthropicSubscription>;
	/** GETs `historyUrl` and returns `{ messages }`. Returns `[]` if not configured. */
	loadHistory(): Promise<{ messages: Message[] }>;
	/** DELETEs `stopUrl`. No-op if not configured. */
	stop(): Promise<void>;
}

async function resolveHeaders(
	headers: S2AnthropicChatOptions["headers"],
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

function setUrlSearchParam(url: string, key: string, value: string): string {
	try {
		const parsed = new URL(url);
		parsed.searchParams.set(key, value);
		return parsed.toString();
	} catch {
		// `url` was relative
	}
	const hashStart = url.indexOf("#");
	const base = hashStart === -1 ? url : url.slice(0, hashStart);
	const hash = hashStart === -1 ? "" : url.slice(hashStart);
	const queryStart = base.indexOf("?");
	const pathname = queryStart === -1 ? base : base.slice(0, queryStart);
	const search = queryStart === -1 ? "" : base.slice(queryStart + 1);
	const params = new URLSearchParams(search);
	params.set(key, value);
	const nextSearch = params.toString();
	return `${pathname}${nextSearch ? `?${nextSearch}` : ""}${hash}`;
}

function resolveSubscribeUrl(
	url: string | ((cursor?: number) => string),
	cursor: number | undefined,
): string {
	if (typeof url === "function") return url(cursor);
	if (cursor === undefined) return url;
	return setUrlSearchParam(url, "from", String(cursor));
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

async function* parseAnthropicSse(
	body: ReadableStream<Uint8Array>,
	abortSignal: AbortSignal | undefined,
	onEventId: (id: string) => void,
): AsyncGenerator<AnthropicWireEvent> {
	const events = body
		.pipeThrough(decodeBytesToText())
		.pipeThrough(new EventSourceParserStream());
	const reader = events.getReader();
	try {
		while (true) {
			if (abortSignal?.aborted) return;
			const { done, value } = await reader.read();
			if (done) return;
			if (value?.id) onEventId(value.id);
			const data = value?.data;
			if (!data) continue;
			try {
				yield JSON.parse(data) as AnthropicWireEvent;
			} catch {
				// Skip malformed JSON frames so the stream can continue.
			}
		}
	} finally {
		reader.releaseLock();
	}
}

async function readResponseOrThrow(
	doFetch: typeof fetch,
	url: string,
	init: RequestInit,
): Promise<Response> {
	const response = await doFetch(url, init);
	if (!response.ok && response.status !== 204) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
	}
	return response;
}

interface SubscriptionContext {
	body: ReadableStream<Uint8Array> | null;
	signal: AbortSignal;
	updateCursor: (id: string) => void;
}

function buildSubscription(ctx: SubscriptionContext): S2AnthropicSubscription {
	const accumulator: AnthropicAccumulator = createAnthropicAccumulator();
	const messageWaiters: Array<{
		resolve: (value: Message) => void;
		reject: (reason?: unknown) => void;
	}> = [];
	let streamFailure: unknown;
	let streamEnded = false;

	const settleAllWaitersWithError = (err: unknown) => {
		while (messageWaiters.length > 0) {
			const waiter = messageWaiters.shift();
			waiter?.reject(err);
		}
	};

	const settleStreamEnded = () => {
		streamEnded = true;
		while (messageWaiters.length > 0) {
			const waiter = messageWaiters.shift();
			waiter?.reject(
				new Error("[anthropic-client] stream ended before message_stop"),
			);
		}
	};

	async function* eventsIter(): AsyncGenerator<AnthropicWireEvent> {
		try {
			if (!ctx.body) {
				settleStreamEnded();
				return;
			}
			for await (const event of parseAnthropicSse(
				ctx.body,
				ctx.signal,
				ctx.updateCursor,
			)) {
				if (event.type !== "error") {
					accumulator.push(event);
					if (event.type === "message_stop") {
						const message = accumulator.finalMessage();
						accumulator.reset();
						const waiter = messageWaiters.shift();
						waiter?.resolve(message);
					}
				}
				yield event;
			}
			settleStreamEnded();
		} catch (err) {
			streamFailure = err;
			settleAllWaitersWithError(err);
			throw err;
		}
	}

	// Single-consumer iterable: a generator's `[Symbol.asyncIterator]()` returns
	// itself, so a second `for await` would see a drained iterator.
	const events: AsyncIterable<AnthropicWireEvent> = eventsIter();

	return {
		events,
		nextMessage(): Promise<Message> {
			if (streamFailure) return Promise.reject(streamFailure);
			if (streamEnded) {
				return Promise.reject(
					new Error("[anthropic-client] stream ended before message_stop"),
				);
			}
			return new Promise<Message>((resolve, reject) => {
				messageWaiters.push({ resolve, reject });
			});
		},
		cancel(): void {
			ctx.body?.cancel().catch(() => {});
		},
	};
}

export function createS2AnthropicChat(
	options: S2AnthropicChatOptions,
): S2AnthropicChat {
	const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	const credentials = options.credentials ?? "same-origin";

	let nextCursor: number | undefined;
	const updateCursor = (id: string) => {
		if (!/^\d+$/.test(id)) return;
		const parsed = Number.parseInt(id, 10);
		if (!Number.isSafeInteger(parsed) || parsed < 0) return;
		if (nextCursor === undefined || parsed > nextCursor) {
			nextCursor = parsed;
		}
	};

	const send = async (
		body: unknown,
		opts?: { signal?: AbortSignal },
	): Promise<S2AnthropicSubscription> => {
		const headers = {
			"Content-Type": "application/json",
			...(await resolveHeaders(options.headers)),
		};
		const signal = opts?.signal ?? new AbortController().signal;
		const response = await readResponseOrThrow(
			doFetch,
			resolveUrl(options.sendUrl),
			{
				method: "POST",
				headers,
				body: JSON.stringify(body),
				credentials,
				signal,
			},
		);
		return buildSubscription({
			body: response.body ?? null,
			signal,
			updateCursor,
		});
	};

	const subscribe = async (opts?: {
		signal?: AbortSignal;
	}): Promise<S2AnthropicSubscription> => {
		const headers = await resolveHeaders(options.headers);
		const signal = opts?.signal ?? new AbortController().signal;
		const response = await readResponseOrThrow(
			doFetch,
			resolveSubscribeUrl(options.subscribeUrl, nextCursor),
			{
				method: "GET",
				headers,
				credentials,
				signal,
			},
		);
		// 204 means no active turn; surface a subscription whose iterable ends immediately.
		if (response.status === 204) {
			return buildSubscription({ body: null, signal, updateCursor });
		}
		return buildSubscription({
			body: response.body ?? null,
			signal,
			updateCursor,
		});
	};

	const loadHistory = async (): Promise<{ messages: Message[] }> => {
		if (!options.historyUrl) return { messages: [] };
		const headers = await resolveHeaders(options.headers);
		const response = await readResponseOrThrow(
			doFetch,
			resolveUrl(options.historyUrl),
			{ method: "GET", headers, credentials },
		);
		if (response.status === 204) return { messages: [] };
		const json = (await response.json()) as { messages?: Message[] };
		return { messages: json.messages ?? [] };
	};

	const stop = async (): Promise<void> => {
		if (!options.stopUrl) return;
		const headers = await resolveHeaders(options.headers);
		await readResponseOrThrow(doFetch, resolveUrl(options.stopUrl), {
			method: "DELETE",
			headers,
			credentials,
		});
	};

	return { send, subscribe, loadHistory, stop };
}
