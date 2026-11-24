import { afterEach, describe, expect, it, vi } from "vitest";
import { S2Error } from "../error.js";
import { AppendInput, AppendRecord, S2 } from "../index.js";
import {
	DEFAULT_RETRY_CONFIG,
	isRetryable,
	sleep,
	withRetries,
} from "../lib/retry.js";

describe("Retry Logic", () => {
	describe("withRetry", () => {
		it("should succeed on first attempt", async () => {
			const fn = vi.fn().mockResolvedValue("success");
			const result = await withRetries(undefined, fn);

			expect(result).toBe("success");
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it("should retry on S2Error with 5xx status", async () => {
			const fn = vi
				.fn()
				.mockRejectedValueOnce(
					new S2Error({ message: "Server error", status: 503 }),
				)
				.mockResolvedValue("success");

			const result = await withRetries(
				{ maxAttempts: 3, minBaseDelayMillis: 1, maxBaseDelayMillis: 1 },
				fn,
			);

			expect(result).toBe("success");
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it("should not retry on S2Error with 4xx status", async () => {
			const error = new S2Error({ message: "Bad request", status: 400 });
			const fn = vi.fn().mockRejectedValue(error);

			await expect(
				withRetries(
					{ maxAttempts: 3, minBaseDelayMillis: 1, maxBaseDelayMillis: 1 },
					fn,
				),
			).rejects.toThrow(error);

			expect(fn).toHaveBeenCalledTimes(1);
		});

		it("should retry on 408 Request Timeout", async () => {
			const fn = vi
				.fn()
				.mockRejectedValueOnce(
					new S2Error({ message: "Request timeout", status: 408 }),
				)
				.mockResolvedValue("success");

			const result = await withRetries(
				{ maxAttempts: 3, minBaseDelayMillis: 1, maxBaseDelayMillis: 1 },
				fn,
			);

			expect(result).toBe("success");
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it("should exhaust retries and throw last error", async () => {
			const error = new S2Error({ message: "Server error", status: 503 });
			const fn = vi.fn().mockRejectedValue(error);

			await expect(
				withRetries(
					{ maxAttempts: 2, minBaseDelayMillis: 1, maxBaseDelayMillis: 1 },
					fn,
				),
			).rejects.toThrow(error);

			// Initial attempt + 1 retry = 2 calls
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it("should not retry when maxAttempts is 1", async () => {
			const error = new S2Error({ message: "Server error", status: 503 });
			const fn = vi.fn().mockRejectedValue(error);

			await expect(
				withRetries(
					{ maxAttempts: 1, minBaseDelayMillis: 1, maxBaseDelayMillis: 1 },
					fn,
				),
			).rejects.toThrow(error);

			expect(fn).toHaveBeenCalledTimes(1);
		});

		it("should use default config when not provided", async () => {
			const fn = vi.fn().mockResolvedValue("success");
			const result = await withRetries(undefined, fn);

			expect(result).toBe("success");
			expect(fn).toHaveBeenCalledTimes(1);
		});
	});

	describe("isRetryable", () => {
		it("should retry 409 transaction_conflict", () => {
			const error = new S2Error({
				message: "transaction conflict",
				status: 409,
				code: "transaction_conflict",
				origin: "server",
			});
			expect(isRetryable(error)).toBe(true);
		});

		it("should not retry 409 without transaction_conflict code", () => {
			const error = new S2Error({
				message: "conflict",
				status: 409,
				origin: "server",
			});
			expect(isRetryable(error)).toBe(false);
		});

		it("should retry 429", () => {
			const error = new S2Error({
				message: "too many requests",
				status: 429,
				origin: "server",
			});
			expect(isRetryable(error)).toBe(true);
		});

		it("should retry 502", () => {
			const error = new S2Error({
				message: "bad gateway",
				status: 502,
				origin: "server",
			});
			expect(isRetryable(error)).toBe(true);
		});

		it("should not retry 400", () => {
			const error = new S2Error({
				message: "bad request",
				status: 400,
				origin: "server",
			});
			expect(isRetryable(error)).toBe(false);
		});
	});

	describe("S2Error.hasNoSideEffects", () => {
		it("returns true for 429 rate_limited from server", () => {
			const error = new S2Error({
				message: "rate limited",
				status: 429,
				code: "rate_limited",
				origin: "server",
			});
			expect(error.hasNoSideEffects()).toBe(true);
		});

		it("returns true for 502 hot_server from server", () => {
			const error = new S2Error({
				message: "hot server",
				status: 502,
				code: "hot_server",
				origin: "server",
			});
			expect(error.hasNoSideEffects()).toBe(true);
		});

		it("returns true for ECONNREFUSED from sdk", () => {
			const error = new S2Error({
				message: "Connection failed: ECONNREFUSED",
				status: 502,
				code: "ECONNREFUSED",
				origin: "sdk",
			});
			expect(error.hasNoSideEffects()).toBe(true);
		});

		it("returns false for 503 from server", () => {
			const error = new S2Error({
				message: "unavailable",
				status: 503,
				origin: "server",
			});
			expect(error.hasNoSideEffects()).toBe(false);
		});

		it("returns false for 500 from server", () => {
			const error = new S2Error({
				message: "internal error",
				status: 500,
				origin: "server",
			});
			expect(error.hasNoSideEffects()).toBe(false);
		});

		it("returns false for 429 without rate_limited code", () => {
			const error = new S2Error({
				message: "too many requests",
				status: 429,
				origin: "server",
			});
			expect(error.hasNoSideEffects()).toBe(false);
		});

		it("returns false for 502 without hot_server code", () => {
			const error = new S2Error({
				message: "bad gateway",
				status: 502,
				origin: "server",
			});
			expect(error.hasNoSideEffects()).toBe(false);
		});

		it("returns false for ECONNRESET from sdk", () => {
			const error = new S2Error({
				message: "Connection failed: ECONNRESET",
				status: 502,
				code: "ECONNRESET",
				origin: "sdk",
			});
			expect(error.hasNoSideEffects()).toBe(false);
		});
	});

	describe("DEFAULT_RETRY_CONFIG", () => {
		it("should have correct default values", () => {
			expect(DEFAULT_RETRY_CONFIG.maxAttempts).toBe(3);
			expect(DEFAULT_RETRY_CONFIG.minBaseDelayMillis).toBe(100);
			expect(DEFAULT_RETRY_CONFIG.maxBaseDelayMillis).toBe(1000);
			expect(DEFAULT_RETRY_CONFIG.appendRetryPolicy).toBe("all");
			expect(DEFAULT_RETRY_CONFIG.requestTimeoutMillis).toBe(5000);
			expect(DEFAULT_RETRY_CONFIG.connectionTimeoutMillis).toBe(3000);
		});
	});
});

describe("retry-after-ms", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	const newS2 = () =>
		new S2({
			accessToken: "token",
			retry: { maxAttempts: 2, minBaseDelayMillis: 1, maxBaseDelayMillis: 1 },
		});

	/** Answers the first request with a 429 carrying `retryAfterMs`, then `ok`. */
	const stubRateLimitedOnce = (retryAfterMs: string, ok: unknown) => {
		const attemptTimes: number[] = [];
		vi.stubGlobal("fetch", async () => {
			attemptTimes.push(performance.now());
			const [status, body, headers] =
				attemptTimes.length === 1
					? [
							429,
							{ code: "rate_limited", message: "slow down" },
							{ "retry-after-ms": retryAfterMs },
						]
					: [200, ok, {}];
			return new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json", ...headers },
			});
		});
		return attemptTimes;
	};

	// The header has to survive from the HTTP response to the retry delay, on
	// both the account and the unary append paths.
	it.each([
		["an account call", [], (s2: S2) => s2.locations.list()],
		[
			"a unary append",
			{
				start: { seq_num: 0, timestamp: 0 },
				end: { seq_num: 1, timestamp: 0 },
				tail: { seq_num: 1, timestamp: 0 },
			},
			(s2: S2) =>
				s2
					.basin("test-basin")
					.stream("s")
					.append(AppendInput.create([AppendRecord.string({ body: "x" })])),
		],
	])("delays the retry of %s past maxBaseDelayMillis", async (_, ok, call) => {
		const attemptTimes = stubRateLimitedOnce("200", ok);

		await call(newS2());

		expect(attemptTimes).toHaveLength(2);
		// Timers may fire a hair early.
		expect(attemptTimes[1]! - attemptTimes[0]!).toBeGreaterThanOrEqual(190);
	});

	it("stops waiting when the caller aborts", async () => {
		const attemptTimes = stubRateLimitedOnce("60000", []);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);

		await expect(
			newS2().locations.list({ signal: controller.signal }),
		).rejects.toMatchObject({ code: "ABORTED" });
		expect(attemptTimes).toHaveLength(1);
	}, 2000);

	// setTimeout fires after 1ms for a delay over 2^31-1 ms.
	it("waits out a delay too long for one timer", async () => {
		vi.useFakeTimers();
		const millis = 2 ** 31 + 1000;
		let done = false;
		void sleep(millis).then(() => {
			done = true;
		});

		await vi.advanceTimersByTimeAsync(millis - 1);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(done).toBe(true);
	});
});
