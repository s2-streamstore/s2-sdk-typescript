import { S2Endpoints, type S2EndpointsInit } from "./endpoints.js";

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
	 * The first retry will have a delay in the range [minBaseDelayMillis, 2*minBaseDelayMillis).
	 * @default 100
	 */
	minBaseDelayMillis?: number;

	/**
	 * Maximum base delay in milliseconds for exponential backoff.
	 * Once the exponential backoff reaches this value, it stays capped here.
	 * Note: actual delay with jitter can be up to 2*maxBaseDelayMillis.
	 * @default 1000
	 */
	maxBaseDelayMillis?: number;

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
	 *
	 * @deprecated Use `requestTimeoutMillis` on {@link S2ClientOptions} instead.
	 */
	requestTimeoutMillis?: number;

	/**
	 * Maximum time in milliseconds to wait for connection establishment.
	 * This is a "fail fast" timeout that aborts slow connections early.
	 * Connection time counts toward requestTimeoutMillis.
	 *
	 * Only applies to S2S (HTTP/2) transport when establishing new connections.
	 * Reused pooled connections are not subject to this timeout.
	 *
	 * @default 3000
	 * @deprecated Use `connectionTimeoutMillis` on {@link S2ClientOptions} instead.
	 */
	connectionTimeoutMillis?: number;
};

export type S2EnvironmentConfig = Partial<S2ClientOptions>;

export class S2Environment {
	public static parse(): S2EnvironmentConfig {
		const config: S2EnvironmentConfig = {};

		const token = process.env.S2_ACCESS_TOKEN;
		if (token) {
			config.accessToken = token;
		}

		const accountEndpoint = process.env.S2_ACCOUNT_ENDPOINT;
		const basinEndpoint = process.env.S2_BASIN_ENDPOINT;
		if (accountEndpoint || basinEndpoint) {
			const endpointsInit: S2EndpointsInit = {
				account: accountEndpoint || undefined,
				basin: basinEndpoint || undefined,
			};
			config.endpoints = new S2Endpoints(endpointsInit);
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
	 * Endpoint configuration for the S2 environment.
	 *
	 * Defaults to AWS (`aws.s2.dev` and `{basin}.b.aws.s2.dev`) with the API base path inferred as `/v1`.
	 */
	endpoints?: S2Endpoints | S2EndpointsInit;
	/**
	 * Maximum time in milliseconds to wait for an append ack before considering
	 * the attempt timed out and applying retry logic.
	 *
	 * Used by retrying append sessions. When unset, defaults to 5000ms.
	 */
	requestTimeoutMillis?: number;
	/**
	 * Maximum time in milliseconds to wait for connection establishment.
	 * This is a "fail fast" timeout that aborts slow connections early.
	 * Connection time counts toward requestTimeoutMillis.
	 *
	 * Only applies to S2S (HTTP/2) transport when establishing new connections.
	 * Reused pooled connections are not subject to this timeout.
	 *
	 * @default 3000
	 */
	connectionTimeoutMillis?: number;
	/**
	 * Retry configuration for handling transient failures.
	 * Applies to management operations (basins, streams, tokens) and stream operations (read, append).
	 * @default { maxAttempts: 3, minBaseDelayMillis: 100, maxBaseDelayMillis: 1000, appendRetryPolicy: "all" }
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
