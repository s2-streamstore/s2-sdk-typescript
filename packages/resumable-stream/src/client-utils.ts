/**
 * Shared client-side utilities for provider-specific browser helpers.
 * Resolves URLs, headers, and the SSE byte-to-event pipeline.
 */
import { EventSourceParserStream } from "eventsource-parser/stream";

export type HeadersOption =
	| HeadersInit
	| (() => HeadersInit | Promise<HeadersInit>);

export async function resolveHeaders(
	headers: HeadersOption | undefined,
): Promise<Record<string, string>> {
	if (!headers) return {};
	const resolved = typeof headers === "function" ? await headers() : headers;
	if (resolved instanceof Headers)
		return Object.fromEntries(resolved.entries());
	if (Array.isArray(resolved)) return Object.fromEntries(resolved);
	return { ...resolved };
}

export function resolveUrl(url: string | (() => string)): string {
	return typeof url === "function" ? url() : url;
}

export function setUrlSearchParam(
	url: string,
	key: string,
	value: string,
): string {
	try {
		const parsed = new URL(url);
		parsed.searchParams.set(key, value);
		return parsed.toString();
	} catch {
		// Fall through for relative URLs, which `new URL(rel)` rejects.
	}
	const hashStart = url.indexOf("#");
	const base = hashStart === -1 ? url : url.slice(0, hashStart);
	const hash = hashStart === -1 ? "" : url.slice(hashStart);
	const queryStart = base.indexOf("?");
	const pathname = queryStart === -1 ? base : base.slice(0, queryStart);
	const search = queryStart === -1 ? "" : base.slice(queryStart + 1);
	const params = new URLSearchParams(search);
	params.set(key, value);
	const next = params.toString();
	return `${pathname}${next ? `?${next}` : ""}${hash}`;
}

export function resolveCursorUrl(
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

export interface ParsedSseFrame {
	event?: string;
	data: string;
	id?: string;
}

/**
 * Pipe a fetch response body through SSE parsing and yield raw frames. Cancels
 * the reader when `abortSignal` fires so the upstream fetch is freed promptly.
 */
export async function* pipeSseFrames(
	body: ReadableStream<Uint8Array>,
	abortSignal?: AbortSignal,
): AsyncGenerator<ParsedSseFrame> {
	const events = body
		.pipeThrough(decodeBytesToText())
		.pipeThrough(new EventSourceParserStream());
	const reader = events.getReader();
	const cancel = () => {
		reader.cancel(abortSignal?.reason).catch(() => {});
	};
	if (abortSignal?.aborted) cancel();
	else abortSignal?.addEventListener("abort", cancel, { once: true });
	try {
		while (true) {
			if (abortSignal?.aborted) return;
			const { done, value } = await reader.read();
			if (done) return;
			yield value;
		}
	} finally {
		abortSignal?.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
}

/** Error thrown by {@link fetchOk} for a non-2xx response, carrying the status. */
export class HttpError extends Error {
	readonly status: number;
	constructor(status: number, statusText: string) {
		super(`HTTP ${status} ${statusText}`.trim());
		this.name = "HttpError";
		this.status = status;
	}
}

export async function fetchOk(
	doFetch: typeof fetch,
	url: string,
	init: RequestInit,
): Promise<Response> {
	const response = await doFetch(url, init);
	if (!response.ok) {
		// Drain the error body so the connection can return to the keep-alive
		// pool; an un-consumed body leaks connections under sustained failures.
		response.body?.cancel().catch(() => {});
		throw new HttpError(response.status, response.statusText);
	}
	return response;
}

/**
 * Whether an error from {@link fetchOk} represents a permanent failure that
 * reconnecting cannot fix. A 4xx response (e.g. 401/403/404) is permanent,
 * except 408 (Request Timeout) and 429 (Too Many Requests), which are worth
 * retrying. Errors without a status (network failures) are treated as transient.
 */
export function isPermanentError(err: unknown): boolean {
	const status = err instanceof HttpError ? err.status : undefined;
	if (status === undefined) return false;
	if (status === 408 || status === 429) return false;
	return status >= 400 && status < 500;
}

export interface SubscribeOptions {
	/**
	 * SSE URL. A string gets `?from=<cursor>` appended on reconnect; a function
	 * receives the cursor and returns the full URL.
	 */
	url: string | ((cursor?: number) => string);
	/** Abort the subscription. */
	signal?: AbortSignal;
	/** Fetch implementation override. */
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

const DEFAULT_BACKOFF_MS = [0, 250, 500, 1000, 2000, 5000] as const;

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

/**
 * Tails an SSE replay. Parses each frame as JSON of type `T`, advances a
 * cursor from each frame's `id:`, and reconnects with `?from=<cursor>` on
 * body drop or transient fetch failure. Ends on HTTP 204, aborted signal, or
 * empty `reconnectBackoffMs`. Throws on a permanent HTTP error (4xx other than
 * 408/429) instead of retrying.
 */
export async function* subscribeSse<T>(
	options: SubscribeOptions,
): AsyncIterable<T> {
	const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	const credentials = options.credentials ?? "same-origin";
	const backoffMs = options.reconnectBackoffMs ?? DEFAULT_BACKOFF_MS;
	const signal = options.signal ?? new AbortController().signal;
	let cursor: number | undefined;

	let attempt = 0;
	let needsReconnect = false;

	while (!signal.aborted) {
		if (needsReconnect) {
			const wait = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 0;
			attempt += 1;
			await sleepAbortable(wait, signal);
			if (signal.aborted) return;
		}

		let response: Response;
		try {
			response = await fetchOk(doFetch, resolveCursorUrl(options.url, cursor), {
				method: "GET",
				headers: await resolveHeaders(options.headers),
				credentials,
				signal,
			});
		} catch (err) {
			if (signal.aborted) return;
			// Permanent failures (e.g. 401/403/404) can't be fixed by reconnecting,
			// so surface them instead of retrying forever.
			if (backoffMs.length === 0 || isPermanentError(err)) throw err;
			needsReconnect = true;
			continue;
		}

		if (response.status === 204 || !response.body) return;

		try {
			for await (const frame of pipeSseFrames(response.body, signal)) {
				if (frame.id) {
					const parsed = Number.parseInt(frame.id, 10);
					if (
						Number.isSafeInteger(parsed) &&
						parsed >= 0 &&
						(cursor === undefined || parsed > cursor)
					) {
						cursor = parsed;
					}
				}
				if (!frame.data) continue;
				attempt = 0;
				try {
					yield JSON.parse(frame.data) as T;
				} catch {}
			}
		} catch (err) {
			// A mid-stream error (e.g. the body drops) is recoverable: fall
			// through to reconnect from the last cursor unless aborted, or
			// rethrow when reconnect is disabled.
			if (signal.aborted) return;
			if (backoffMs.length === 0) throw err;
		}

		if (signal.aborted) return;
		if (backoffMs.length === 0) return;
		needsReconnect = true;
	}
}

/**
 * AbortController whose signal aborts when `external` aborts, but which can
 * also be aborted independently. Lets a caller's signal propagate without
 * preventing the subscription itself from triggering cancellation.
 */
export function linkedAbortController(external?: AbortSignal): AbortController {
	const controller = new AbortController();
	if (!external) return controller;
	if (external.aborted) {
		controller.abort(external.reason);
		return controller;
	}
	external.addEventListener("abort", () => controller.abort(external.reason), {
		once: true,
	});
	return controller;
}
