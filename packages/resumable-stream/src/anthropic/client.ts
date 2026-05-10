/**
 * Client-side helpers for consuming a `@s2-dev/resumable-stream/anthropic`
 * server. The wire format is Anthropic-native SSE; we parse it back into
 * `RawMessageStreamEvent`s and (optionally) reassemble `Message`s.
 *
 * `subscribe()` and `send()` auto-reconnect: on body drop or transient fetch
 * failure they reissue a GET against `subscribeUrl` with the latest cursor
 * (`?from=<seqNum>`) and exponential backoff. The reconnect loop ends on a
 * terminal event (`message_stop` / `error`), HTTP 204, or external abort.
 */
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import {
	fetchOk,
	type HeadersOption,
	linkedAbortController,
	pipeSseFrames,
	resolveCursorUrl,
	resolveHeaders,
	resolveUrl,
} from "../client-utils.js";
import type { Chunk } from "./accumulator.js";

export type { Chunk } from "./accumulator.js";

export interface ChatClientOptions {
	/** Endpoint that POSTs the request body and starts a generation. */
	sendUrl: string | (() => string);
	/** Endpoint that GETs the SSE replay stream. Reconnect uses `?from=<cursor>`. */
	subscribeUrl: string | ((cursor?: number) => string);
	/** Optional: endpoint that returns `{ messages: Message[], nextSeqNum?: number }` JSON. */
	historyUrl?: string | (() => string);
	/** Optional: endpoint that stops the active generation (DELETE). */
	stopUrl?: string | (() => string);
	fetch?: typeof fetch;
	headers?: HeadersOption;
	/** Forwarded to fetch. Defaults to `same-origin`. */
	credentials?: RequestCredentials;
	/**
	 * Backoff schedule (ms) between reconnect attempts. Index `n` is the wait
	 * before the `n`-th reconnect; the last value is reused after that. The
	 * counter resets on every received event. Pass `[]` to disable reconnect.
	 */
	reconnectBackoffMs?: readonly number[];
}

export interface Subscription {
	events: AsyncIterable<Chunk>;
	cancel(): void;
}

export interface ChatClient {
	send(body: unknown, opts?: { signal?: AbortSignal }): Promise<Subscription>;
	subscribe(opts?: { signal?: AbortSignal }): Promise<Subscription>;
	loadHistory(): Promise<{ messages: Message[]; nextSeqNum?: number }>;
	stop(): Promise<void>;
}

const DEFAULT_BACKOFF_MS = [0, 250, 500, 1000, 2000, 5000] as const;

function isValidCursor(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTerminal(event: Chunk): boolean {
	return event.type === "message_stop" || event.type === "error";
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
	});
}

export function createChatClient(options: ChatClientOptions): ChatClient {
	const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	const credentials = options.credentials ?? "same-origin";
	const backoffMs = options.reconnectBackoffMs ?? DEFAULT_BACKOFF_MS;

	let cursor: number | undefined;
	const advanceCursor = (next: number) => {
		if (cursor === undefined || next > cursor) cursor = next;
	};

	const reconnectFetch = async (signal: AbortSignal): Promise<Response> =>
		fetchOk(doFetch, resolveCursorUrl(options.subscribeUrl, cursor), {
			method: "GET",
			headers: await resolveHeaders(options.headers),
			credentials,
			signal,
		});

	/**
	 * Drains a response body, yielding parsed events. Returns whether a
	 * terminal event was seen — the reconnect loop uses this to decide
	 * whether to keep going.
	 */
	async function* drainBody(
		body: ReadableStream<Uint8Array>,
		signal: AbortSignal,
		onEvent: () => void,
	): AsyncGenerator<Chunk, boolean> {
		for await (const frame of pipeSseFrames(body, signal)) {
			if (frame.id) {
				const parsed = Number.parseInt(frame.id, 10);
				if (isValidCursor(parsed)) advanceCursor(parsed);
			}
			if (!frame.data) continue;
			let event: Chunk;
			try {
				event = JSON.parse(frame.data) as Chunk;
			} catch {
				continue;
			}
			onEvent();
			yield event;
			if (isTerminal(event)) return true;
		}
		return false;
	}

	function tailWithReconnect(
		controller: AbortController,
		initialResponse: Response,
	): AsyncIterable<Chunk> {
		const signal = controller.signal;
		return (async function* () {
			let response = initialResponse;
			let needsFetch = false;
			let attempt = 0;
			const resetBackoff = () => {
				attempt = 0;
			};

			while (!signal.aborted) {
				if (needsFetch) {
					const wait = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 0;
					attempt += 1;
					await sleepAbortable(wait, signal);
					if (signal.aborted) return;
					try {
						response = await reconnectFetch(signal);
						needsFetch = false;
					} catch {
						if (signal.aborted) return;
						continue;
					}
				}
				if (response.status === 204 || !response.body) return;
				let terminated = false;
				try {
					terminated = yield* drainBody(response.body, signal, resetBackoff);
				} catch {
					if (signal.aborted) return;
				}
				if (terminated || signal.aborted) return;
				if (backoffMs.length === 0) return;
				needsFetch = true;
			}
		})();
	}

	const fetchAndTail = async (
		url: string,
		init: RequestInit,
		external?: AbortSignal,
	): Promise<Subscription> => {
		const controller = linkedAbortController(external);
		const response = await fetchOk(doFetch, url, {
			...init,
			credentials,
			signal: controller.signal,
		});
		return {
			events: tailWithReconnect(controller, response),
			cancel: () => controller.abort(),
		};
	};

	return {
		async send(body, opts) {
			return fetchAndTail(
				resolveUrl(options.sendUrl),
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(await resolveHeaders(options.headers)),
					},
					body: JSON.stringify(body),
				},
				opts?.signal,
			);
		},
		async subscribe(opts) {
			return fetchAndTail(
				resolveCursorUrl(options.subscribeUrl, cursor),
				{ method: "GET", headers: await resolveHeaders(options.headers) },
				opts?.signal,
			);
		},
		async loadHistory() {
			if (!options.historyUrl) return { messages: [] };
			const response = await fetchOk(doFetch, resolveUrl(options.historyUrl), {
				method: "GET",
				headers: await resolveHeaders(options.headers),
				credentials,
			});
			if (response.status === 204) return { messages: [] };
			const json = (await response.json()) as {
				messages?: Message[];
				nextSeqNum?: number;
			};
			const nextSeqNum = isValidCursor(json.nextSeqNum)
				? json.nextSeqNum
				: undefined;
			if (nextSeqNum !== undefined) advanceCursor(nextSeqNum);
			return { messages: json.messages ?? [], nextSeqNum };
		},
		async stop() {
			if (!options.stopUrl) return;
			await fetchOk(doFetch, resolveUrl(options.stopUrl), {
				method: "DELETE",
				headers: await resolveHeaders(options.headers),
				credentials,
			});
		},
	};
}
