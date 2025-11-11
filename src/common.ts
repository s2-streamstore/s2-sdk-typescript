/**
 * Policy for retrying append operations.
 *
 * - `all`: Retry all append operations, including those that may have side effects
 * - `noSideEffects`: Only retry append operations that are guaranteed to have no side effects
 */
export type AppendRetryPolicy = "all" | "noSideEffects";

/**
 * Retry configuration for handling transient failures.
 */
export type RetryConfig = {
	/**
	 * Maximum number of retry attempts.
	 * Set to 0 to disable retries.
	 * @default 3
	 */
	maxAttempts?: number;

	/**
	 * Base delay in milliseconds between retry attempts.
	 * Uses exponential backoff: delay = retryBackoffDurationMs * (2 ^ attempt)
	 * @default 100
	 */
	retryBackoffDurationMs?: number;

	/**
	 * Policy for retrying append operations.
	 * @default "noSideEffects"
	 */
	appendRetryPolicy?: AppendRetryPolicy;

	/**
	 * Maximum time in milliseconds to wait for an append ack before considering
	 * the attempt timed out and applying retry logic.
	 *
	 * Used by retrying append sessions. When unset, defaults to 5000ms.
	 */
	requestTimeoutMillis?: number;
};

/**
 * Configuration for constructing the top-level `S2` client.
 *
 * - The client authenticates using a Bearer access token on every request.
 */
export type S2ClientOptions = {
	/**
	 * Access token used for HTTP Bearer authentication.
	 * Typically obtained via your S2 account or created using `s2.accessTokens.issue`.
	 */
	accessToken: string;
	/**
	 * Base URL for the S2 API.
	 * Defaults to `https://aws.s2.dev`.
	 */
	baseUrl?: string;
	/**
	 * Function to make a basin-specific base URL.
	 * Defaults to `https://{basin}.b.aws.s2.dev`.
	 */
	makeBasinBaseUrl?: (basin: string) => string;
	/**
	 * Retry configuration for handling transient failures.
	 * Applies to management operations (basins, streams, tokens) and stream operations (read, append).
	 * @default { maxAttempts: 3, retryBackoffDurationMs: 100 }
	 */
	retry?: RetryConfig;
};

/**
 * Per-request options that apply to all SDK operations.
 */
export type S2RequestOptions = {
	/**
	 * Optional abort signal to cancel the underlying HTTP request.
	 */
	signal?: AbortSignal;
};

/**
 * Helper type that flattens an endpoint's `body`, `path` and `query` into a
 * single object. This lets public methods accept one coherent argument object
 * instead of three separate bags.
 */
export type DataToObject<T> = (T extends { body?: infer B }
	? B extends undefined | never
		? {}
		: B
	: {}) &
	(T extends { path?: infer P } ? (P extends undefined | never ? {} : P) : {}) &
	(T extends { query?: infer Q } ? (Q extends undefined | never ? {} : Q) : {});
