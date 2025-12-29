import * as Redacted from "./lib/redacted.js";

/**
 * Policy for retrying append operations.
 *
 * - `all`: Retry all append operations, including those that may have side effects (default)
 * - `noSideEffects`: Only retry append operations that are guaranteed to have no side effects
 */
export type AppendRetryPolicy = "all" | "noSideEffects";

/**
 * Retry configuration for handling transient failures.
 */
export type RetryConfig = {
	/**
	 * Total number of attempts, including the initial try.
	 * Must be >= 1. A value of 1 means no retries.
	 * @default 3
	 */
	maxAttempts?: number;

	/**
	 * Minimum delay in milliseconds for exponential backoff.
	 * The first retry will have a delay in the range [minDelayMillis, 2*minDelayMillis).
	 * @default 100
	 */
	minDelayMillis?: number;

	/**
	 * Maximum base delay in milliseconds for exponential backoff.
	 * Once the exponential backoff reaches this value, it stays capped here.
	 * Note: actual delay with jitter can be up to 2*maxDelayMillis.
	 * @default 1000
	 */
	maxDelayMillis?: number;

	/**
	 * Policy for retrying append operations.
	 * @default "all"
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

export type S2EnvironmentConfig = Partial<S2ClientOptions>;

export class S2Environment {
	public static parse(): S2EnvironmentConfig {
		const config: S2EnvironmentConfig = {};

		const token = process.env.S2_ACCESS_TOKEN;
		if (token) {
			config.accessToken = token;
		}

		const baseUrl = process.env.S2_ACCOUNT_ENDPOINT;
		if (baseUrl) {
			config.baseUrl = baseUrl;
		}

		const basinEndpoint = process.env.S2_BASIN_ENDPOINT;
		if (basinEndpoint) {
			config.makeBasinBaseUrl = basinEndpoint.includes("{basin}")
				? (basin: string) => basinEndpoint.replace("{basin}", basin)
				: () => basinEndpoint;
		}

		return config;
	}
}

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
	 * @default { maxAttempts: 3, minDelayMillis: 100, maxDelayMillis: 1000, appendRetryPolicy: "all" }
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
