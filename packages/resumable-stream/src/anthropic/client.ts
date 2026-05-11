/**
 * Client-side helpers for consuming a `@s2-dev/resumable-stream/anthropic`
 * server. Assistant events use Anthropic SSE; optional `user_message` events
 * carry submitted user text.
 *
 * `subscribe()` and `send()` auto-reconnect: on body drop or transient fetch
 * failure they reissue a GET against `subscribeUrl` with the latest cursor
 * (`?from=<seqNum>`) and exponential backoff. By default, the reconnect loop
 * ends on a terminal event (`message_stop` / `error`), HTTP 204, or external
 * abort. Pass `{ stopOnTerminal: false }` for live session streams.
 */
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
import {
	emptyHistorySnapshot,
	type HistorySnapshot,
	normalizeHistorySnapshot,
} from "./history.js";

export type { Chunk } from "./accumulator.js";
export { messagesFromEvents } from "./accumulator.js";
export type { HistoryError, HistorySnapshot, HistoryTurn } from "./history.js";

export interface ChatClientOptions {
	/** Endpoint that POSTs the request body and starts a generation. */
	sendUrl: string | (() => string);
	/**
	 * Endpoint that GETs the SSE replay stream. String URLs receive `?from=<cursor>`
	 * automatically on reconnect; function URLs receive the cursor and should add
	 * any query params they need.
	 */
	subscribeUrl: string | ((cursor?: number) => string);
	/** Optional endpoint that returns `{ turns, messages, nextSeqNum }` JSON. */
	historyUrl?: string | (() => string);
	/** Optional endpoint used by `stop()`; called as `DELETE`. */
	stopUrl?: string | (() => string);
	/** Fetch implementation override for tests, non-browser runtimes, or wrappers. */
	fetch?: typeof fetch;
	/** Static or lazy headers sent with every request. */
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

export interface StreamOptions {
	/** Abort signal for the returned request/subscription. */
	signal?: AbortSignal;
	/**
	 * End the client stream when `message_stop` or `error` arrives. Defaults to
	 * true. Set false when `subscribeUrl` is a live session stream that should
	 * stay open for future turns.
	 */
	stopOnTerminal?: boolean;
}

export interface Subscription {
	/** Parsed Anthropic/user/error events from the SSE stream. */
	events: AsyncIterable<Chunk>;
	/** Abort the underlying request and stop yielding events. */
	cancel(): void;
}

export interface ChatClient {
	/**
	 * POST a JSON body to `sendUrl`. If the response is empty/202, the client
	 * opens `subscribeUrl` and yields replayed events from S2.
	 */
	send(body: unknown, opts?: StreamOptions): Promise<Subscription>;
	/** GET `subscribeUrl` from the latest cursor and yield replayed events. */
	subscribe(opts?: StreamOptions): Promise<Subscription>;
	/** Load history and advance the internal replay cursor to `nextSeqNum`. */
	loadHistory(): Promise<HistorySnapshot>;
	/** DELETE `stopUrl` when configured; otherwise a no-op. */
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
	if (ms <= 0 || signal.aborted) return Promise.resolve();
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

async function closeResponse(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => {});
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
		stopOnTerminal: boolean,
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
			if (stopOnTerminal && isTerminal(event)) return true;
		}
		return false;
	}

	function tailWithReconnect(
		controller: AbortController,
		initialResponse: Response,
		stopOnTerminal: boolean,
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
					terminated = yield* drainBody(
						response.body,
						signal,
						resetBackoff,
						stopOnTerminal,
					);
				} catch {
					if (signal.aborted) return;
				}
				if (terminated) {
					controller.abort();
					await closeResponse(response);
					return;
				}
				if (signal.aborted) return;
				if (backoffMs.length === 0) return;
				needsFetch = true;
			}
		})();
	}

	const fetchAndTail = async (
		url: string,
		init: RequestInit,
		external?: AbortSignal,
		stopOnTerminal = true,
		onEmptyResponse?: (signal: AbortSignal) => Promise<Response>,
	): Promise<Subscription> => {
		const controller = linkedAbortController(external);
		let response = await fetchOk(doFetch, url, {
			...init,
			credentials,
			signal: controller.signal,
		});
		if ((response.status === 202 || !response.body) && onEmptyResponse) {
			response = await onEmptyResponse(controller.signal);
		}
		return {
			events: tailWithReconnect(controller, response, stopOnTerminal),
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
				opts?.stopOnTerminal ?? true,
				reconnectFetch,
			);
		},
		async subscribe(opts) {
			return fetchAndTail(
				resolveCursorUrl(options.subscribeUrl, cursor),
				{ method: "GET", headers: await resolveHeaders(options.headers) },
				opts?.signal,
				opts?.stopOnTerminal ?? true,
			);
		},
		async loadHistory() {
			if (!options.historyUrl) return emptyHistorySnapshot();
			const response = await fetchOk(doFetch, resolveUrl(options.historyUrl), {
				method: "GET",
				headers: await resolveHeaders(options.headers),
				credentials,
			});
			if (response.status === 204) return emptyHistorySnapshot();
			const history = normalizeHistorySnapshot(await response.json());
			advanceCursor(history.nextSeqNum);
			return history;
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
