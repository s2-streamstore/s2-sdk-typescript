import { describe, expect, it, vi } from "vitest";
import { S2Error } from "../error.js";
import { DEFAULT_RETRY_CONFIG, withRetries } from "../lib/retry.js";

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
				{ maxAttempts: 3, retryBackoffDurationMs: 1 },
				fn,
			);

			expect(result).toBe("success");
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it("should not retry on S2Error with 4xx status", async () => {
			const error = new S2Error({ message: "Bad request", status: 400 });
			const fn = vi.fn().mockRejectedValue(error);

			await expect(
				withRetries({ maxAttempts: 3, retryBackoffDurationMs: 1 }, fn),
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
				{ maxAttempts: 3, retryBackoffDurationMs: 1 },
				fn,
			);

			expect(result).toBe("success");
			expect(fn).toHaveBeenCalledTimes(2);
		});

		// Note: Tests for connection and abort errors will be added after implementing
		// error kind discrimination (see claude.md). For now, withS2Error converts these
		// to S2Error with status=undefined, and isRetryable doesn't handle them yet.

		it("should exhaust retries and throw last error", async () => {
			const error = new S2Error({ message: "Server error", status: 503 });
			const fn = vi.fn().mockRejectedValue(error);

			await expect(
				withRetries({ maxAttempts: 2, retryBackoffDurationMs: 1 }, fn),
			).rejects.toThrow(error);

			// Initial attempt + 2 retries = 3 calls
			expect(fn).toHaveBeenCalledTimes(3);
		});

		it("should not retry when maxAttempts is 0", async () => {
			const error = new S2Error({ message: "Server error", status: 503 });
			const fn = vi.fn().mockRejectedValue(error);

			await expect(
				withRetries({ maxAttempts: 0, retryBackoffDurationMs: 1 }, fn),
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

	describe("DEFAULT_RETRY_CONFIG", () => {
		it("should have correct default values", () => {
			expect(DEFAULT_RETRY_CONFIG.maxAttempts).toBe(3);
			expect(DEFAULT_RETRY_CONFIG.retryBackoffDurationMs).toBe(100);
			expect(DEFAULT_RETRY_CONFIG.appendRetryPolicy).toBe("noSideEffects");
		});
	});
});
