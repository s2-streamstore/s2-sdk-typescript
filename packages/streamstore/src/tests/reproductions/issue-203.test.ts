import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppendInput, AppendRecord } from "../../index.js";
import type { AppendResult, CloseResult } from "../../lib/result.js";
import { RetryAppendSession as AppendSessionImpl } from "../../lib/retry.js";
import type { TransportAppendSession } from "../../lib/stream/types.js";

/**
 * Issue #203: Abort during an in-flight append corrupts capacity accounting.
 *
 * The pump awaits `waitForHead(head)`, which races the transport `submit()`
 * promise against the request timeout. If `abort()` fires while the pump is
 * parked there, it sets `pumpStopped = true`, empties `inflight`, and resets
 * `queuedBytes = 0`. When the transport promise then resolves with a (now
 * stale) success, the pump resumed down the success path and called
 * `releaseCapacity(meteredBytes)`, driving `queuedBytes` negative and
 * permanently corrupting backpressure accounting.
 *
 * The fix adds a `pumpStopped` guard immediately after `waitForHead()` returns,
 * matching the guards that already follow every other await point in the pump.
 */

describe("Issue #203: abort during in-flight append must not corrupt capacity", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not make queuedBytes negative when abort races a late success", async () => {
		let submitResolve: ((result: AppendResult) => void) | undefined;

		const slowTransport: TransportAppendSession = {
			submit: () =>
				new Promise<AppendResult>((resolve) => {
					submitResolve = resolve;
				}),
			close: async (): Promise<CloseResult> => ({ ok: true }),
			effectSignalled: () => false,
		};

		const session = await AppendSessionImpl.create(
			async () => slowTransport,
			undefined,
			{
				maxAttempts: 3,
				minBaseDelayMillis: 1,
				maxBaseDelayMillis: 1,
				requestTimeoutMillis: 10000,
			},
		);

		await session.submit(
			AppendInput.create([AppendRecord.string({ body: "test" })]),
		);

		// Let the pump submit() and park in waitForHead().
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(10);
			await Promise.resolve();
		}

		expect((session as any).queuedBytes).toBeGreaterThan(0);
		expect(submitResolve).toBeDefined();

		// Abort while the pump is parked in waitForHead().
		const { abortedError } = await import("../../error.js");
		await (session as any).abort(abortedError("test abort"));

		// abort() resets accounting.
		expect((session as any).queuedBytes).toBe(0);
		expect((session as any).inflight.length).toBe(0);
		expect((session as any).pumpStopped).toBe(true);

		// Resolve the transport promise with a late success.
		submitResolve!({
			ok: true,
			value: {
				start: { seqNum: 0, timestamp: new Date() },
				end: { seqNum: 1, timestamp: new Date() },
				tail: { seqNum: 1, timestamp: new Date() },
			},
		});

		// Let the pump process (and, without the fix, mishandle) the stale result.
		for (let i = 0; i < 30; i++) {
			await vi.advanceTimersByTimeAsync(10);
			await Promise.resolve();
		}

		// With the fix, the pump returns immediately after waitForHead() and never
		// calls releaseCapacity(), so the invariant holds.
		expect((session as any).queuedBytes).toBe(0);
		expect((session as any).queuedBytes).toBeGreaterThanOrEqual(0);
	}, 10000);
});
