import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppendInput, AppendRecord } from "../../index.js";
import { RetryAppendSession as AppendSessionImpl } from "../../lib/retry.js";

describe("Issue #150: RetryAppendSession ignores maxAttempts on connection failures", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("aborts after maxAttempts when ensureSession always fails", async () => {
		let createCalls = 0;
		const session = await AppendSessionImpl.create(
			async () => {
				createCalls++;
				throw new Error("connection refused");
			},
			undefined,
			{
				maxAttempts: 3,
				minBaseDelayMillis: 1,
				maxBaseDelayMillis: 1,
			},
		);

		const ticket = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "hello" })]),
		);

		// Advance timers to allow retries and backoff delays to complete
		for (let i = 0; i < 20; i++) {
			await vi.advanceTimersByTimeAsync(10);
			await Promise.resolve();
		}

		await expect(ticket.ack()).rejects.toMatchObject({
			message: expect.stringContaining("Max attempts (3) exhausted"),
		});

		// With maxAttempts=3, we expect 3 total creation attempts (1 initial + 2 retries)
		expect(createCalls).toBe(3);
	});

	it("aborts immediately with maxAttempts=1 on connection failure", async () => {
		let createCalls = 0;
		const session = await AppendSessionImpl.create(
			async () => {
				createCalls++;
				throw new Error("connection refused");
			},
			undefined,
			{
				maxAttempts: 1,
				minBaseDelayMillis: 1,
				maxBaseDelayMillis: 1,
			},
		);

		const ticket = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "hello" })]),
		);

		// Advance timers to allow the pump to run
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(10);
			await Promise.resolve();
		}

		await expect(ticket.ack()).rejects.toMatchObject({
			message: expect.stringContaining("Max attempts (1) exhausted"),
		});

		// With maxAttempts=1, only 1 creation attempt (no retries)
		expect(createCalls).toBe(1);
	});
});
