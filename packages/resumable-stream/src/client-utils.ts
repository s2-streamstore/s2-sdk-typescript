/**
 * Shared client-side utilities for `tanstack-ai-client` and `anthropic-client`.
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

export async function fetchOk(
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
