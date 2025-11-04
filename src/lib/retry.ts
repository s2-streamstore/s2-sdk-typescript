import createDebug from "debug";
import type { RetryConfig } from "../common.js";
import { S2Error } from "../error.js";

const debug = createDebug("s2:retry");

/**
 * Default retry configuration.
 */
export const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
	maxAttempts: 3,
	retryBackoffDurationMs: 100,
	appendRetryPolicy: "noSideEffects",
};

const RETRYABLE_STATUS_CODES = new Set([
	408, // request_timeout
	429, // too_many_requests
	500, // internal_server_error
	503, // service_unavailable
]);

/**
 * Determines if an error should be retried based on its characteristics.
 */
export function isRetryable(error: S2Error): boolean {
	return !!error.status && RETRYABLE_STATUS_CODES.has(error.status);
}

/**
 * Calculates the delay before the next retry attempt using exponential backoff.
 */
export function calculateDelay(attempt: number, baseDelayMs: number): number {
	// Exponential backoff: baseDelay * (2 ^ attempt)
	const delay = baseDelayMs * Math.pow(2, attempt);
	// Add jitter: random value between 0 and delay
	const jitter = Math.random() * delay;
	return Math.floor(delay + jitter);
}

/**
 * Sleeps for the specified duration.
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes an async function with automatic retry logic for transient failures.
 *
 * @param retryConfig Retry configuration (max attempts, backoff duration)
 * @param fn The async function to execute
 * @returns The result of the function
 * @throws The last error if all retry attempts are exhausted
 */
export async function withRetries<T>(
	retryConfig: RetryConfig | undefined,
	fn: () => Promise<T>,
	isPolicyCompliant: (config: RetryConfig, error: S2Error) => boolean = () =>
		true,
): Promise<T> {
	const config = {
		...DEFAULT_RETRY_CONFIG,
		...retryConfig,
	};

	// If maxAttempts is 0, don't retry at all
	if (config.maxAttempts === 0) {
		debug("maxAttempts is 0, retries disabled");
		return fn();
	}

	let lastError: S2Error | undefined = undefined;

	for (let attempt = 0; attempt <= config.maxAttempts; attempt++) {
		try {
			const result = await fn();
			if (attempt > 0) {
				debug("succeeded after %d retries", attempt);
			}
			return result;
		} catch (error) {
			// withRetry only handles S2Errors (withS2Error should be called first)
			if (!(error instanceof S2Error)) {
				debug("non-S2Error thrown, rethrowing immediately: %s", error);
				throw error;
			}

			lastError = error;

			// Don't retry if this is the last attempt
			if (attempt === config.maxAttempts) {
				debug("max attempts exhausted, throwing error");
				break;
			}

			// Check if error is retryable
			if (!isPolicyCompliant(config, lastError) || !isRetryable(lastError)) {
				debug("error not retryable, throwing immediately");
				throw error;
			}

			// Calculate delay and wait before retrying
			const delay = calculateDelay(attempt, config.retryBackoffDurationMs);
			debug(
				"retryable error, backing off for %dms, status=%s",
				delay,
				error.status,
			);
			await sleep(delay);
		}
	}

	throw lastError;
}
