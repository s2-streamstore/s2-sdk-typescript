import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppendInput, AppendRecord } from "../../index.js";
import { RetryAppendSession as AppendSessionImpl } from "../../lib/retry.js";
import type { TransportAppendSession } from "../../lib/stream/types.js";
import type { AppendResult, CloseResult } from "../../lib/result.js";

/**
 * Issue #179: Aborting an idle RetryAppendSession can hang close() indefinitely.
 *
 * The pump loop parks (awaits pumpWakeup) when the inflight queue is empty.
 * abort() sets pumpStopped=true but never calls pumpWakeup(), so the pump
 * never wakes up to check the flag. close() then awaits pumpPromise which
 * never resolves — unless close() also calls pumpWakeup(), which it does.
 *
 * While close() masks the hang in most scenarios by calling pumpWakeup()
 * itself, the pump still runs forever if close() is never called (resource
 * leak). The fix: abort() should call pumpWakeup() so the pump exits
 * promptly regardless of whether close() is ever called.
 */

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

describe("Issue #179: aborting idle RetryAppendSession hangs close()", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("pump exits after abort() without needing close() to wake it", async () => {
		const session = await AppendSessionImpl.create(
			async () => createMockTransport(),
			undefined,
			{
				maxAttempts: 3,
				minBaseDelayMillis: 1,
				maxBaseDelayMillis: 1,
			},
		);

		// Submit a record to start the pump
		const ticket = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "hello" })]),
		);

		// Let the pump process the submission and park (become idle)
		for (let i = 0; i < 20; i++) {
			await vi.advanceTimersByTimeAsync(10);
			await Promise.resolve();
		}

		// The ack should have resolved successfully
		await ticket.ack();

		// Now the pump is parked (idle, no inflight entries).
		// Access the private pumpPromise to verify pump lifecycle directly.
		const pumpPromise = (session as any).pumpPromise as Promise<void>;
		expect(pumpPromise).toBeDefined();

		// Trigger abort directly via the private abort method to bypass
		// WritableStream's internal async machinery which interacts poorly
		// with fake timers.
		const { abortedError } = await import("../../error.js");
		const abortError = abortedError("test abort");
		await (session as any).abort(abortError);

		// Let microtasks settle — the pump should wake and exit with the fix.
		// Without the fix, pumpPromise stays pending because pumpWakeup was
		// never called by abort().
		// The pump needs several microtask cycles to: wake → check flag → return
		// → resolve pumpPromise → resolve .catch() wrapper.
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(0);
			await Promise.resolve();
		}

		// Check if pumpPromise has settled by racing against a sentinel.
		const result = await Promise.race([
			pumpPromise.then(() => "settled"),
			Promise.resolve("pending"),
		]);

		// With fix: "settled" (pump exited after abort woke it)
		// Without fix: "pending" (pump still parked, awaiting pumpWakeup)
		expect(result).toBe("settled");
	}, 10000);

	it("close() resolves promptly after abort() on a parked pump", async () => {
		const session = await AppendSessionImpl.create(
			async () => createMockTransport(),
			undefined,
			{
				maxAttempts: 3,
				minBaseDelayMillis: 1,
				maxBaseDelayMillis: 1,
			},
		);

		// Submit a record and let it be processed
		const ticket = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "test" })]),
		);

		for (let i = 0; i < 20; i++) {
			await vi.advanceTimersByTimeAsync(10);
			await Promise.resolve();
		}

		await ticket.ack();

		// Abort
		const writer = session.writable.getWriter();
		await writer.abort("forced abort").catch(() => {});

		// Let microtasks settle
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
		await Promise.resolve();

		// close() should not hang — it should resolve (or throw the abort error)
		const settled = await Promise.race([
			session
				.close()
				.then(() => "resolved")
				.catch(() => "rejected"),
			vi.advanceTimersByTimeAsync(5000).then(() => "hung"),
		]);

		expect(settled).not.toBe("hung");
	}, 10000);
});
