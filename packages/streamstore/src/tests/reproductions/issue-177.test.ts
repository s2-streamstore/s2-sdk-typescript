import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppendInput, AppendRecord, S2Error } from "../../index.js";
import type { AppendResult, CloseResult } from "../../lib/result.js";
import { RetryAppendSession as AppendSessionImpl } from "../../lib/retry.js";
import type { TransportAppendSession } from "../../lib/stream/types.js";

/**
 * Issue #177: ticket.ack() can hang forever if close() happens during
 * backpressure.
 *
 * When submit() is blocked in waitForCapacity() and close() is called,
 * the pump loop can stop before the capacity waiter's microtask adds
 * the new entry to inflight. The entry is never processed and
 * ticket.ack() hangs indefinitely.
 *
 * The fix: close() wakes capacity waiters, and waitForCapacity() checks
 * the closing flag so blocked submits fail fast with "AppendSession is
 * closed" instead of producing tickets whose ack() never settles.
 */

function createSlowMockTransport(): TransportAppendSession {
	let seqNum = 0;
	return {
		submit: async (input): Promise<AppendResult> => {
			// Add a small delay to simulate network round-trip
			await new Promise((r) => setTimeout(r, 10));
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

describe("Issue #177: ticket.ack() hangs when close() races with backpressure", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("submit() rejects when close() is called while waiting for capacity", async () => {
		// Create session with very small capacity so the second submit blocks
		const session = await AppendSessionImpl.create(
			async () => createSlowMockTransport(),
			{
				maxInflightBatches: 1,
			},
			{
				maxAttempts: 1,
				minBaseDelayMillis: 1,
				maxBaseDelayMillis: 1,
			},
		);

		// First submit fills the single batch slot
		const ticket1 = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "first" })]),
		);

		// Second submit should block on capacity (maxInflightBatches=1)
		let submit2Error: Error | undefined;
		const submit2Promise = session
			.submit(AppendInput.create([AppendRecord.string({ body: "second" })]))
			.catch((err: Error) => {
				submit2Error = err;
				return undefined;
			});

		// Let microtasks settle (submit2 is now blocked in waitForCapacity)
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();

		// Call close() while submit2 is still blocked on capacity.
		// With the fix, close() wakes capacity waiters and waitForCapacity
		// checks the closing flag, causing submit2 to reject.
		const closePromise = session.close();

		// Process the first submit so the pump can proceed
		for (let i = 0; i < 30; i++) {
			await vi.advanceTimersByTimeAsync(20);
			await Promise.resolve();
		}

		// Both close and submit2 should settle
		await closePromise;
		await submit2Promise;

		// submit2 should have been rejected because session is closing
		expect(submit2Error).toBeDefined();
		expect(submit2Error).toBeInstanceOf(S2Error);
		expect(submit2Error!.message).toContain("closed");

		// ticket1 should still complete normally
		await ticket1.ack();
	}, 10000);

	it("ticket.ack() does not hang when close() races with capacity release", async () => {
		// This test validates the specific race condition described in #177:
		// pump releases capacity → wakeCapacityWaiters removes waiter →
		// pump checks closing && inflight==0 && waiters==0 → stops →
		// waiter microtask runs → adds to inflight → but pump already stopped
		const session = await AppendSessionImpl.create(
			async () => createSlowMockTransport(),
			{
				maxInflightBatches: 1,
			},
			{
				maxAttempts: 1,
				minBaseDelayMillis: 1,
				maxBaseDelayMillis: 1,
			},
		);

		// Fill the capacity
		const ticket1 = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "fill" })]),
		);

		// Block on capacity
		let submit2Settled = false;
		const submit2Promise = session
			.submit(AppendInput.create([AppendRecord.string({ body: "blocked" })]))
			.then((ticket) => {
				submit2Settled = true;
				return ticket;
			})
			.catch(() => {
				submit2Settled = true;
				return undefined;
			});

		// Let submit2 park in waitForCapacity
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();

		// Close while submit2 is blocked
		const closePromise = session.close();

		// Let everything settle (pump processes ticket1, wakes waiters, etc.)
		for (let i = 0; i < 50; i++) {
			await vi.advanceTimersByTimeAsync(20);
			await Promise.resolve();
		}

		// close() must resolve (not hang)
		const closeResult = await Promise.race([
			closePromise.then(() => "resolved"),
			vi.advanceTimersByTimeAsync(5000).then(() => "hung"),
		]);
		expect(closeResult).toBe("resolved");

		// submit2 must have settled (either rejected or returned a ticket
		// whose ack() resolves/rejects). It must NOT hang.
		expect(submit2Settled).toBe(true);

		// Ensure submit2Promise is fully settled
		await submit2Promise;
	}, 10000);
});
