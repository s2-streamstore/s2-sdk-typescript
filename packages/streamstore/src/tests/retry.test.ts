import { describe, expect, it, vi } from "vitest";
import { S2Error } from "../error.js";
import { AppendInput, AppendRecord } from "../index.js";
import {
	DEFAULT_RETRY_CONFIG,
	isRetryable,
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
