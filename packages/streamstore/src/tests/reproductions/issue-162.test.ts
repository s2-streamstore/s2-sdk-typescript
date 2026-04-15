import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppendInput, AppendRecord } from "../../index.js";
import {
	RetryAppendSession as AppendSessionImpl,
	RetryReadSession as ReadSessionImpl,
} from "../../lib/retry.js";
import type {
	TransportAppendSession,
	TransportReadSession,
} from "../../lib/stream/types.js";
import type { AppendResult, CloseResult } from "../../lib/result.js";
import { S2Error } from "../../error.js";

/**
 * Issue #162: RetryReadSession and RetryAppendSession continue retrying
 * after cancel/abort, leaking transport sessions.
 *
 * Bugs:
 * 1. RetryReadSession retry loop doesn't check for cancellation after
 *    async gaps (generator, sleep), so cancelled streams keep retrying.
 * 2. RetryAppendSession's acks ReadableStream is missing a cancel()
 *    handler, so cancelling the acks stream doesn't trigger abort().
 * 3. RetryAppendSession pump doesn't check pumpStopped after
 *    ensureSession() and recover(), so it can submit to leaked sessions.
 */

describe("Issue #162: retry sessions should stop on cancel/abort", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	describe("RetryReadSession", () => {
		it("cancellation during inner retry backoff stops further session creation", async () => {
			let generatorCallCount = 0;

			// First call succeeds (so create() returns), subsequent calls fail
			const generator = async (): Promise<TransportReadSession<"string">> => {
				generatorCallCount++;
				if (generatorCallCount === 1) {
					// Return a session that yields one record then errors
					const records = [
						{
							ok: true as const,
							value: {
								seq_num: 0,
								timestamp: new Date().toISOString(),
								body: "first",
								headers: [],
							},
						},
						{
							ok: false as const,
							error: new S2Error({
								message: "server error",
								status: 503,
							}),
						},
					];
					let index = 0;
					const stream = new ReadableStream({
						pull(controller) {
							if (index < records.length) {
								controller.enqueue(records[index++]);
							}
						},
					});
					return Object.assign(stream, {
						cancel: async () => {},
						lastObservedTail: () => undefined,
					}) as any;
				}
				// Subsequent calls fail with retryable error
				throw new S2Error({
					message: "service unavailable",
					status: 503,
				});
			};

			const session = await ReadSessionImpl.create(generator, {}, {
				maxAttempts: 10,
				minBaseDelayMillis: 100,
				maxBaseDelayMillis: 500,
			});

			expect(generatorCallCount).toBe(1);

			// Read the first record (success)
			const reader = session.getReader();
			const first = await reader.read();
			expect(first.done).toBe(false);

			// Now the inner loop will get the error and enter retry backoff.
			// Advance time to let the error be processed and backoff sleep to start.
			// We need to release the reader first so cancel works.
			reader.releaseLock();

			// Give the retry loop time to process the error, attempt generator
			// (which fails), and enter sleep.
			for (let i = 0; i < 5; i++) {
				await vi.advanceTimersByTimeAsync(200);
				await Promise.resolve();
			}

			const countBeforeCancel = generatorCallCount;

			// Cancel the stream during the backoff sleep
			await session.cancel("test cancel");

			// Advance time well past any remaining backoff
			for (let i = 0; i < 20; i++) {
				await vi.advanceTimersByTimeAsync(1000);
				await Promise.resolve();
			}

			// With the fix: no more generator calls after cancel
			// Without the fix: generator keeps being called during retries
			expect(generatorCallCount).toBeLessThanOrEqual(countBeforeCancel + 1);
		}, 15000);
	});

	describe("RetryAppendSession", () => {
		function createMockTransport(): TransportAppendSession {
			let seqNum = 0;
			return {
				submit: async (input): Promise<AppendResult> => {
					const start = seqNum;
					seqNum += input.records.length;
					return {
						ok: true,
						value: {
							start: { seqNum: start, timestamp: new Date() },
							end: { seqNum, timestamp: new Date() },
							tail: { seqNum, timestamp: new Date() },
						},
					};
				},
				close: async (): Promise<CloseResult> => ({ ok: true }),
				effectSignalled: () => false,
			};
		}

		it("cancelling acks readable triggers abort", async () => {
			const session = await AppendSessionImpl.create(
				async () => createMockTransport(),
				undefined,
				{
					maxAttempts: 3,
					minBaseDelayMillis: 1,
					maxBaseDelayMillis: 1,
				},
			);

			// Submit a record and let it process
			const ticket = await session.submit(
				AppendInput.create([AppendRecord.string({ body: "hello" })]),
			);

			for (let i = 0; i < 20; i++) {
				await vi.advanceTimersByTimeAsync(10);
				await Promise.resolve();
			}

			await ticket.ack();

			// Cancel the acks readable stream
			await session.readable.cancel("test cancel");

			// Allow microtasks to settle
			for (let i = 0; i < 10; i++) {
				await vi.advanceTimersByTimeAsync(0);
				await Promise.resolve();
			}

			// The session should now be in a failed state
			// (failureCause should be set by the abort triggered from cancel)
			const cause = session.failureCause();
			expect(cause).toBeDefined();
			expect(cause?.message).toContain("cancelled");
		}, 10000);

		it("pump stops promptly after abort during ensureSession", async () => {
			let sessionCreationCount = 0;

			// Generator that always fails (simulates connection issues)
			const generator = async (): Promise<TransportAppendSession> => {
				sessionCreationCount++;
				throw new S2Error({
					message: "service unavailable",
					status: 503,
				});
			};

			const session = await AppendSessionImpl.create(
				generator,
				undefined,
				{
					maxAttempts: 10,
					minBaseDelayMillis: 50,
					maxBaseDelayMillis: 200,
				},
			);

			// Submit a record to start the pump
			const ticket = await session.submit(
				AppendInput.create([AppendRecord.string({ body: "test" })]),
			);

			// Let the pump try a few times
			for (let i = 0; i < 5; i++) {
				await vi.advanceTimersByTimeAsync(300);
				await Promise.resolve();
			}

			const countBeforeAbort = sessionCreationCount;

			// Abort the session
			const { abortedError } = await import("../../error.js");
			await (session as any).abort(abortedError("test abort"));

			// Advance time significantly
			for (let i = 0; i < 20; i++) {
				await vi.advanceTimersByTimeAsync(1000);
				await Promise.resolve();
			}

			// Should not have created many more sessions after abort
			expect(sessionCreationCount).toBeLessThanOrEqual(countBeforeAbort + 1);

			// Clean up
			await ticket.ack().catch(() => {});
		}, 10000);

		it("pump checks pumpStopped after recover backoff", async () => {
			let sessionCount = 0;

			const generator = async (): Promise<TransportAppendSession> => {
				sessionCount++;
				const thisSessionNum = sessionCount;
				let seqNum = 0;
				return {
					submit: async (input): Promise<AppendResult> => {
						// First session always fails with retryable error
						if (thisSessionNum === 1) {
							return {
								ok: false,
								error: new S2Error({
									message: "server error",
									status: 503,
								}),
							};
						}
						const start = seqNum;
						seqNum += input.records.length;
						return {
							ok: true,
							value: {
								start: { seqNum: start, timestamp: new Date() },
								end: { seqNum, timestamp: new Date() },
								tail: { seqNum, timestamp: new Date() },
							},
						};
					},
					close: async (): Promise<CloseResult> => ({ ok: true }),
					effectSignalled: () => false,
				};
			};

			const session = await AppendSessionImpl.create(generator, undefined, {
				maxAttempts: 5,
				minBaseDelayMillis: 100,
				maxBaseDelayMillis: 500,
			});

			// Submit to trigger the pump
			const ticket = await session.submit(
				AppendInput.create([AppendRecord.string({ body: "test" })]),
			);

			// Let the pump submit to first session and get the error
			for (let i = 0; i < 5; i++) {
				await vi.advanceTimersByTimeAsync(10);
				await Promise.resolve();
			}

			// Now the pump should be in recover() doing backoff sleep.
			// Abort during the backoff.
			const { abortedError } = await import("../../error.js");
			await (session as any).abort(abortedError("test abort during recovery"));

			// Let microtasks and timers settle
			for (let i = 0; i < 20; i++) {
				await vi.advanceTimersByTimeAsync(1000);
				await Promise.resolve();
			}

			// With the fix, the pump should stop during recovery backoff
			// and NOT create many sessions after the initial one.
			expect(sessionCount).toBeLessThanOrEqual(2);

			// Clean up
			await ticket.ack().catch(() => {});
		}, 10000);
	});
});
