/**
 * Connects TanStack AI's `useChat` to a resumable S2 chat endpoint.
 *
 * `send` starts a turn on your server; `subscribe` reads the replay stream so
 * the same turn can keep going after a refresh or reconnect.
 */
import type { ModelMessage, StreamChunk, UIMessage } from "@tanstack/ai";
import type { SubscribeConnectionAdapter } from "@tanstack/ai-client";
import {
	fetchOk,
	type HeadersOption,
	pipeSseFrames,
	resolveCursorUrl,
	resolveHeaders,
	resolveUrl,
} from "../client-utils.js";

export type { ConnectionAdapter } from "@tanstack/ai-client";

type Messages = ReadonlyArray<UIMessage> | ReadonlyArray<ModelMessage>;

export interface ConnectionOptions {
	/** Endpoint that POSTs `{ messages, data, ...body }` and starts a generation. */
	sendUrl: string | (() => string);
	/**
	 * Endpoint that GETs the SSE replay. String URLs receive `?from=<cursor>`
	 * automatically after chunks have been seen; function URLs receive the cursor.
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
	 * reconnect. Defaults to `[]` so TanStack owns the subscription lifecycle.
	 */
	reconnectBackoffMs?: readonly number[];
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

function advanceCursor(
	state: { cursor: number | undefined },
	id: string | undefined,
): void {
	if (!id) return;
	const parsed = Number.parseInt(id, 10);
	if (
		Number.isSafeInteger(parsed) &&
		parsed >= 0 &&
		(state.cursor === undefined || parsed > state.cursor)
	) {
		state.cursor = parsed;
	}
}

async function* subscribeChunks(
	options: ConnectionOptions,
	state: { cursor: number | undefined },
	signal: AbortSignal,
): AsyncIterable<StreamChunk> {
	const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	const credentials = options.credentials ?? "same-origin";
	const backoffMs = options.reconnectBackoffMs ?? [];
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
			response = await fetchOk(
				doFetch,
				resolveCursorUrl(options.subscribeUrl, state.cursor),
				{
					method: "GET",
					headers: await resolveHeaders(options.headers),
					credentials,
					signal,
				},
			);
		} catch (err) {
			if (signal.aborted) return;
			if (backoffMs.length === 0) throw err;
			needsReconnect = true;
			continue;
		}

		if (response.status === 204 || !response.body) return;

		try {
			for await (const frame of pipeSseFrames(response.body, signal)) {
				advanceCursor(state, frame.id);
				if (!frame.data) continue;
				attempt = 0;
				try {
					yield JSON.parse(frame.data) as StreamChunk;
				} catch {}
			}
		} catch (err) {
			if (signal.aborted) return;
			if (backoffMs.length === 0) throw err;
		}

		if (signal.aborted) return;
		if (backoffMs.length === 0) return;
		needsReconnect = true;
	}
}

/** Builds a TanStack `SubscribeConnectionAdapter` backed by an S2 replay. */
export function createConnection(
	options: ConnectionOptions,
): SubscribeConnectionAdapter {
	const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	const credentials = options.credentials ?? "same-origin";
	const subscriptionState: { cursor: number | undefined } = {
		cursor: undefined,
	};

	return {
		subscribe(signal): AsyncIterable<StreamChunk> {
			return subscribeChunks(
				options,
				subscriptionState,
				signal ?? new AbortController().signal,
			);
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
