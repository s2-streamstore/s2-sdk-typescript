/**
 * Client-side connection adapter for TanStack AI's `useChat`, wired to a
 * `@s2-dev/resumable-stream/tanstack-ai` server. Types come from `@tanstack/ai`
 * / `@tanstack/ai-client` (type-only — both are optional peer deps).
 */
import type { ModelMessage, StreamChunk, UIMessage } from "@tanstack/ai";
import type { SubscribeConnectionAdapter } from "@tanstack/ai-client";
import {
	fetchOk,
	type HeadersOption,
	resolveHeaders,
	resolveUrl,
	subscribeSse,
} from "../client-utils.js";

export type { ConnectionAdapter } from "@tanstack/ai-client";

type Messages = ReadonlyArray<UIMessage> | ReadonlyArray<ModelMessage>;

export interface ConnectionOptions {
	/** Endpoint that POSTs `{ messages, data, ...body }` and starts a generation. */
	sendUrl: string | (() => string);
	/**
	 * Endpoint that GETs the SSE replay. String URLs receive `?from=<cursor>`
	 * automatically on reconnect; function URLs receive the cursor.
	 */
	subscribeUrl: string | ((cursor?: number) => string);
	/** Extra headers added to both fetches. May be a (possibly async) factory. */
	headers?: HeadersOption;
	/** Extra fields merged into the POST body alongside `{ messages, data }`. */
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
	/**
	 * Backoff schedule (ms) between reconnect attempts on `subscribe`. Index `n`
	 * is the wait before the `n`-th reconnect; the last value is reused after
	 * that. The counter resets on every received event. Pass `[]` to disable
	 * reconnect.
	 */
	reconnectBackoffMs?: readonly number[];
}

/** Builds a TanStack `SubscribeConnectionAdapter` backed by an S2 replay. */
export function createConnection(
	options: ConnectionOptions,
): SubscribeConnectionAdapter {
	const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	const credentials = options.credentials ?? "same-origin";

	// TanStack's `useChat` drives subscription lifecycle, so default to a
	// single-shot fetch with no internal reconnect. Override via options.
	const reconnectBackoffMs = options.reconnectBackoffMs ?? [];
	// Cursor persists across subscribe() calls so successive turns resume
	// from where the previous one left off.
	const cursorRef: { current: number | undefined } = { current: undefined };

	return {
		subscribe(signal): AsyncIterable<StreamChunk> {
			return subscribeSse<StreamChunk>({
				url: options.subscribeUrl,
				signal,
				fetch: options.fetch,
				headers: options.headers,
				credentials,
				reconnectBackoffMs,
				cursorRef,
			});
		},
		async send(messages, data, signal): Promise<void> {
			const extra =
				typeof options.body === "function"
					? options.body(messages, data)
					: (options.body ?? {});
			await fetchOk(doFetch, resolveUrl(options.sendUrl), {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(await resolveHeaders(options.headers)),
				},
				body: JSON.stringify({ messages, data, ...extra }),
				credentials,
				signal,
			});
		},
	};
}
