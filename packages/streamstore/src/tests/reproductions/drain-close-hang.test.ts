import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconnectAdvisedError, S2Error } from "../../error.js";
import { AppendInput, AppendRecord } from "../../index.js";
import type { AppendResult, CloseResult } from "../../lib/result.js";
import { RetryAppendSession as AppendSessionImpl } from "../../lib/retry.js";
import type { TransportAppendSession } from "../../lib/stream/types.js";
import type { AppendAck } from "../../types.js";

/**
 * Regression tests for the drain-handoff/hang bug introduced by the
 * "planned drain handoff" path in `RetryAppendSession.runPump`.
 *
 * Before the fix, `server_draining` / `reconnect_advised` errors were handed
 * off with `recover(0)` (zero backoff) and no `closing` check, so on a
 * transport that keeps accepting connections while returning a drain error
 * the pump busy-spun for the whole drain window, and `close()` plus every
 * outstanding `ticket.ack()` hung until the window ended.
 *
 * These tests cover:
 *  - `close()` interrupts a persistent drain window promptly.
 *  - Drain handoffs apply backoff (no zero-delay tight loop).
 *  - `close()` preempts a drain window that would otherwise succeed.
 *  - A bounded drain window (drain twice, then success) still succeeds
 *    without spending the retry budget (no regression in the happy path).
 *  - `reconnect_advised` is treated the same as `server_draining`.
 */

function serverDrainingError(): S2Error {
	return new S2Error({
		message: "server draining",
		status: 503,
		code: "server_draining",
		origin: "server",
	});
}

/** Transport whose submit() always returns `error`. Models a draining
 * server that keeps accepting connections but returns a drain error from
 * every submit() during the drain window. */
class DrainingTransport implements TransportAppendSession {
	public submitCalls = 0;
	constructor(private readonly error: S2Error) {}
	async submit(_input: AppendInput): Promise<AppendResult> {
		this.submitCalls++;
		return { ok: false, error: this.error };
	}
	async close(): Promise<CloseResult> {
		return { ok: true };
	}
	effectSignalled(): boolean {
		return false;
	}
}

/** Transport that acks each submitted batch, modeling a non-draining server. */
class SuccessTransport implements TransportAppendSession {
	public submitCalls = 0;
	async submit(input: AppendInput): Promise<AppendResult> {
		this.submitCalls++;
		const count = input.records.length;
		const ack: AppendAck = {
			start: { seqNum: 0, timestamp: new Date(0) },
			end: { seqNum: count, timestamp: new Date(0) },
			tail: { seqNum: count, timestamp: new Date(0) },
		};
		return { ok: true, value: ack };
	}
	async close(): Promise<CloseResult> {
		return { ok: true };
	}
	effectSignalled(): boolean {
		return false;
	}
}

/** Settle `p` within `steps` timer advances of `stepMs`; return "hung" if it
 * never settles. Drives the pump with fake timers while giving the promise a
 * bounded window to resolve. */
async function settleOrHung<T>(
	p: Promise<T>,
	steps = 1000,
	stepMs = 20,
): Promise<{ ok: true; value: T } | { ok: false; hung: true }> {
	for (let i = 0; i < steps; i++) {
		const advance = vi.advanceTimersByTimeAsync(stepMs);
		const raced = await Promise.race([
			p.then((value) => ({ ok: true as const, value })),
			advance.then(() => ({ ok: false as const })),
		]);
		if (raced.ok) return raced;
		// If the promise did not settle, the advance completed; loop and
		// advance another slice.
	}
	return { ok: false, hung: true };
}

describe("RetryAppendSession drain handoff: close() interrupt and backoff", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("close() interrupts a persistent drain window instead of hanging for its duration", async () => {
		const drainErr = serverDrainingError();
		const session = await AppendSessionImpl.create(
			async () => new DrainingTransport(drainErr),
			undefined,
			{
				minBaseDelayMillis: 10,
				maxBaseDelayMillis: 10,
				maxAttempts: 5,
				appendRetryPolicy: "all",
			},
		);

		const ticket = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "x" })]),
		);

		// Let the pump submit, observe the first drain error, and enter its
		// first drain-handoff backoff sleep (inflight entry pinned).
		await vi.advanceTimersByTimeAsync(5);
		await Promise.resolve();

		// Now call close(). Before the fix this hung for the whole drain
		// window; with the fix the pump aborts on the next drain handoff
		// after observing `closing && draining`.
		const closeResult = await settleOrHung(
			session
				.close()
				.then(() => "closed" as const)
				.catch((e: S2Error) => `rejected:${e.code ?? e.message}` as const),
		);
		expect(closeResult.ok).toBe(true);
		if (!closeResult.ok) return; // for TS narrowing
		expect(closeResult.value).not.toBe("hung");
		// close() surfaces the fatal drain error that aborted inflight
		// entries (consistent with the existing fatalError contract).
		expect(closeResult.value).toBe(`rejected:${drainErr.code}`);

		// The inflight ticket.ack() settles (rejects) with the drain error
		// instead of hanging.
		const ackResult = await settleOrHung(
			ticket
				.ack()
				.then(() => "acked" as const)
				.catch((e: S2Error) => `rejected:${e.code ?? e.message}` as const),
		);
		expect(ackResult.ok).toBe(true);
		if (!ackResult.ok) return;
		expect(ackResult.value).toBe(`rejected:${drainErr.code}`);

		// The session is in a fatal state surfaced via failureCause().
		expect(session.failureCause()).toMatchObject({
			code: "server_draining",
			status: 503,
		});
	}, 10_000);

	it("drain handoffs apply backoff: submit() is not a zero-delay tight loop", async () => {
		const drainErr = serverDrainingError();
		const transports: DrainingTransport[] = [];
		const session = await AppendSessionImpl.create(
			async () => {
				const t = new DrainingTransport(drainErr);
				transports.push(t);
				return t;
			},
			undefined,
			{
				minBaseDelayMillis: 50,
				maxBaseDelayMillis: 50,
				// Keep a high budget so the pump cannot abort via the
				// max-attempts gate during the test window; the only thing
				// bounding handoffs here is the drain backoff.
				maxAttempts: 100,
				appendRetryPolicy: "all",
			},
		);

		await session.submit(
			AppendInput.create([AppendRecord.string({ body: "x" })]),
		);

		// Advance the clock by exactly 4 backoff intervals (200ms). With a
		// 50ms drain backoff the pump completes at most ~5 handoffs in this
		// window (one initial submit plus ~4 resubmits). Before the fix this
		// was a `recover(0)` tight loop that issued hundreds of submit()
		// calls into the same window (or tripped the fake-timer safeguard).
		await vi.advanceTimersByTimeAsync(200);

		const totalSubmits = transports.reduce((sum, t) => sum + t.submitCalls, 0);
		// Sanity: at least two drain handoffs happened.
		expect(totalSubmits).toBeGreaterThanOrEqual(2);
		// Backoff bound: far fewer than a zero-backoff tight loop.
		expect(totalSubmits).toBeLessThan(12);

		// Tear down without hanging: close() must abort the drain loop.
		const closeResult = await settleOrHung(
			session
				.close()
				.then(() => "closed" as const)
				.catch(() => "rejected" as const),
		);
		expect(closeResult.ok).toBe(true);
	}, 10_000);

	it("close() while draining preempts a drain window that would otherwise succeed", async () => {
		const drainErr = serverDrainingError();
		const sessions: TransportAppendSession[] = [];
		let generation = 0;
		const session = await AppendSessionImpl.create(
			async () => {
				generation++;
				// First 2 sessions drain; the 3rd would succeed (end of the
				// drain window).
				const s: TransportAppendSession =
					generation <= 2
						? new DrainingTransport(drainErr)
						: new SuccessTransport();
				sessions.push(s);
				return s;
			},
			undefined,
			{
				minBaseDelayMillis: 10,
				maxBaseDelayMillis: 10,
				maxAttempts: 5,
				appendRetryPolicy: "all",
			},
		);

		const ticket = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "x" })]),
		);

		// Enter the first drain handoff (inflight entry pinned).
		await vi.advanceTimersByTimeAsync(5);
		await Promise.resolve();

		// close() during the drain window must abort BEFORE the pump reaches
		// the would-be-successful 3rd session.
		const closeResult = await settleOrHung(
			session
				.close()
				.then(() => "closed" as const)
				.catch((e: S2Error) => `rejected:${e.code ?? e.message}` as const),
		);
		expect(closeResult.ok).toBe(true);
		if (!closeResult.ok) return;
		expect(closeResult.value).toBe(`rejected:${drainErr.code}`);

		const ackResult = await settleOrHung(
			ticket
				.ack()
				.then(() => "acked" as const)
				.catch((e: S2Error) => `rejected:${e.code ?? e.message}` as const),
		);
		expect(ackResult.ok).toBe(true);
		if (!ackResult.ok) return;
		expect(ackResult.value).toBe(`rejected:${drainErr.code}`);

		// The successful 3rd session was never created: close() preempted
		// the drain handoff instead of running the window to completion.
		expect(sessions.some((s) => s instanceof SuccessTransport)).toBe(false);
		// At most the two draining sessions are created before the abort.
		expect(sessions.length).toBeLessThanOrEqual(2);
		expect(session.failureCause()).toMatchObject({
			code: "server_draining",
			status: 503,
		});
	}, 10_000);

	it("a bounded drain window (drain twice, then success) still succeeds without spending the retry budget under the `all` policy", async () => {
		const sessions: TransportAppendSession[] = [];
		let generation = 0;
		let successTransport: SuccessTransport | undefined;
		const session = await AppendSessionImpl.create(
			async () => {
				generation++;
				const s: TransportAppendSession =
					generation <= 2
						? new DrainingTransport(serverDrainingError())
						: new SuccessTransport();
				if (s instanceof SuccessTransport) successTransport = s;
				sessions.push(s);
				return s;
			},
			undefined,
			{
				minBaseDelayMillis: 1,
				maxBaseDelayMillis: 1,
				// A budget that allows zero retries. The drain handoff must
				// not consume it, or the first drain frame would abort.
				maxAttempts: 1,
				appendRetryPolicy: "all",
			},
		);

		const p = session.submit(
			AppendInput.create([AppendRecord.string({ body: "x" })]),
		);
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(10);
		await Promise.resolve();
		const ticket = await p;
		const ack = await ticket.ack();
		expect(ack.end.seqNum - ack.start.seqNum).toBe(1);
		expect(sessions).toHaveLength(3);
		expect(successTransport?.submitCalls).toBe(1);
		// No fatal error: the drain handoffs recovered within budget.
		expect(session.failureCause()).toBeUndefined();
	}, 10_000);

	it("close() interrupts reconnect_advised drain handoffs the same as server_draining", async () => {
		const drainErr = reconnectAdvisedError();
		const session = await AppendSessionImpl.create(
			async () => new DrainingTransport(drainErr),
			undefined,
			{
				minBaseDelayMillis: 10,
				maxBaseDelayMillis: 10,
				maxAttempts: 5,
				appendRetryPolicy: "all",
			},
		);

		const ticket = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "x" })]),
		);
		await vi.advanceTimersByTimeAsync(5);
		await Promise.resolve();

		const closeResult = await settleOrHung(
			session
				.close()
				.then(() => "closed" as const)
				.catch((e: S2Error) => `rejected:${e.code ?? e.message}` as const),
		);
		expect(closeResult.ok).toBe(true);
		if (!closeResult.ok) return;
		expect(closeResult.value).toBe(`rejected:${drainErr.code}`);

		const ackResult = await settleOrHung(
			ticket
				.ack()
				.then(() => "acked" as const)
				.catch((e: S2Error) => `rejected:${e.code ?? e.message}` as const),
		);
		expect(ackResult.ok).toBe(true);
		if (!ackResult.ok) return;
		expect(ackResult.value).toBe(`rejected:${drainErr.code}`);

		expect(session.failureCause()).toMatchObject({
			code: "reconnect_advised",
			status: 503,
		});
	}, 10_000);

	it("persistent draining under the noSideEffects policy also unblocks close()", async () => {
		const drainErr = serverDrainingError();
		const session = await AppendSessionImpl.create(
			async () => new DrainingTransport(drainErr),
			undefined,
			{
				minBaseDelayMillis: 10,
				maxBaseDelayMillis: 10,
				maxAttempts: 5,
				appendRetryPolicy: "noSideEffects",
			},
		);

		const ticket = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "x" })]),
		);
		await vi.advanceTimersByTimeAsync(5);
		await Promise.resolve();

		const closeResult = await settleOrHung(
			session
				.close()
				.then(() => "closed" as const)
				.catch((e: S2Error) => `rejected:${e.code ?? e.message}` as const),
		);
		expect(closeResult.ok).toBe(true);
		if (!closeResult.ok) return;
		expect(closeResult.value).toBe(`rejected:${drainErr.code}`);

		const ackResult = await settleOrHung(
			ticket
				.ack()
				.then(() => "acked" as const)
				.catch((e: S2Error) => `rejected:${e.code ?? e.message}` as const),
		);
		expect(ackResult.ok).toBe(true);
		if (!ackResult.ok) return;
		expect(ackResult.value).toBe(`rejected:${drainErr.code}`);

		expect(session.failureCause()).toMatchObject({
			code: "server_draining",
			status: 503,
		});
	}, 10_000);
});
