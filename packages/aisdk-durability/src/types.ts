import type { S2Endpoints, S2EndpointsInit } from "@s2-dev/streamstore";

/** Server-side config shared across all persist/replay calls. */
export interface DurableChatConfig {
	/** S2 access token. */
	accessToken: string;
	/** Basin name. */
	basin: string;
	/** Optional S2 endpoint overrides (e.g. for s2-lite). */
	endpoints?: S2Endpoints | S2EndpointsInit;
	/** Number of records to batch together when appending. Defaults to 10. */
	batchSize?: number;
	/** Max time to wait before flushing a batch (ms). Defaults to 50. */
	lingerDuration?: number;
}

/** Options passed per-request to {@link DurableChat.persist}. */
export interface PersistOptions {
	/**
	 * Keep the background write alive after the response is sent.
	 *
	 * On edge runtimes (e.g. Next.js), pass `after` from `"next/server"`.
	 * In Node / long-lived servers you can omit this — the promise will
	 * resolve on its own.
	 *
	 * When omitted, `persist` awaits the full write before responding.
	 */
	waitUntil?: (promise: Promise<unknown>) => void;
}

/** Returned by {@link createDurableChat}. */
export interface DurableChat {
	/**
	 * Persist an AI SDK stream to S2 and return a JSON response containing
	 * the stream name (`{ stream }`).
	 *
	 * When `waitUntil` is provided the write runs in the background and the
	 * response is sent immediately. Otherwise the write completes first.
	 */
	persist(
		streamName: string,
		source: AsyncIterable<unknown>,
		options?: PersistOptions,
	): Promise<Response>;

	/**
	 * Read a previously persisted stream from S2 and return a streaming
	 * NDJSON response.
	 *
	 * Use this for a server-side replay endpoint when you prefer not to
	 * expose S2 credentials to the browser.
	 */
	replay(streamName: string): Promise<Response>;
}

/** Client-side read credentials for direct S2 SSE reads. */
export interface DurableReadConfig {
	/** S2 access token (ideally a scoped read-only token). */
	accessToken: string;
	/** Basin name. */
	basin: string;
	/**
	 * Full base URL of the basin endpoint
	 * (e.g. `"https://mybas.b.s2.dev"`).
	 *
	 * Defaults to `"https://{basin}.b.s2.dev"`.
	 */
	baseUrl?: string;
}

/** Config for {@link createDurableChatTransport}. */
export interface DurableChatTransportConfig {
	/** API endpoint for submitting chat messages (POST). */
	api: string;
	/**
	 * API endpoint for reconnecting to an in-flight generation (GET).
	 * Falls back to `{api}/{chatId}/stream` when omitted.
	 */
	reconnectApi?: string;
	/** Credentials for direct S2 SSE reads. */
	s2: DurableReadConfig;
	/** Default headers included in every request to your API. */
	headers?: HeadersInit;
	/** Custom fetch implementation. */
	fetchClient?: typeof fetch;
}
