import { describe, expect, it } from "vitest";
import { S2Error } from "../../error.js";
import type { AppendResult, CloseResult } from "../../lib/result.js";
import { ok, okClose } from "../../lib/result.js";
import { RetryAppendSession as AppendSessionImpl } from "../../lib/retry.js";
import type { TransportAppendSession } from "../../lib/stream/types.js";
import {
	type AppendAck,
	AppendInput,
	AppendRecord,
	MAX_APPEND_BYTES,
} from "../../types.js";
import { meteredBytes } from "../../utils.js";

/**
 * Regression: a record whose declared `meteredBytes` was missing or non-finite
 * used to slip past `AppendInput.create` (the documented validation boundary)
 * and poison the cached total. `RetryAppendSession` then trusted
 * `input.meteredBytes` for byte-based backpressure; `NaN <= maxQueuedBytes` is
 * always false, so the submit parked in `capacityWaiters` forever and — as the
 * FIFO head — starved every waiter behind it. Via the `Producer` API a single
 * such record wedged the entire producer for all subsequent writes, with zero
 * errors surfaced to any caller. Introduced in 0d76a27, which made the session
 * trust `input.meteredBytes` instead of recomputing per record.
 *
 * The fix mirrors the established invariant in
 * `packages/patterns/src/patterns/dedupe.ts` (which recomputes
 * `meteredBytes(record)` after mutating headers): `AppendInput.create`
 * recomputes the metered size of every record via the exported `meteredBytes()`
 * util and rejects a non-finite total. A malformed declared field is therefore
 * ignored and the session's capacity queue is never poisoned by a NaN value.
 */
describe("AppendInput.create recomputes meteredBytes and is not poisoned by a non-finite declared value", () => {
	it("ignores a non-finite or missing declared meteredBytes and stores the recomputed total", () => {
		// body "hello" with no headers = 8 (overhead) + 5 (body) = 13 bytes.
		const recomputed = meteredBytes({ body: "hello" });
		expect(recomputed).toBe(13);

		// A declared NaN, an omitted field, or a lying-but-finite value all
		// yield the same recomputed total, so the cached value is finite and
		// `RetryAppendSession.submit` never sees a NaN capacity request.
		expect(
			AppendInput.create([{ body: "hello", meteredBytes: Number.NaN } as any])
				.meteredBytes,
		).toBe(recomputed);
		expect(AppendInput.create([{ body: "hello" } as any]).meteredBytes).toBe(
			recomputed,
		);
		expect(
			AppendInput.create([{ body: "hello", meteredBytes: 999_999 } as any])
				.meteredBytes,
		).toBe(recomputed);
	});

	it("rejects a record whose recomputed size is non-finite", () => {
		// A truthy body that is neither string nor Uint8Array has no meaningful
		// byte length, so recomputation is NaN. The boundary rejects rather than
		// caching a NaN that would wedge the capacity queue.
		expect(() => AppendInput.create([{ body: 123 } as any])).toThrow(S2Error);
	});
});

/**
 * A transport session whose acks are controlled by the test, used to drive the
 * real `RetryAppendSession` capacity queue under backpressure.
 */
class HeldAckTransport implements TransportAppendSession {
	private readonly pending: Array<(r: AppendResult) => void> = [];
	private _effectSignalled = false;

	effectSignalled(): boolean {
		return this._effectSignalled;
	}

	submit(_input: AppendInput): Promise<AppendResult> {
		this._effectSignalled = true;
		return new Promise<AppendResult>((resolve) => {
			this.pending.push(resolve);
		});
	}

	ackNext(start: number, count: number): void {
		const resolve = this.pending.shift();
		if (!resolve) {
			return;
		}
		this._effectSignalled = false;
		const end = start + count;
		const ack: AppendAck = {
			start: { seqNum: start, timestamp: new Date(0) },
			end: { seqNum: end, timestamp: new Date(0) },
			tail: { seqNum: end, timestamp: new Date(0) },
		};
		resolve(ok(ack));
	}

	async close(): Promise<CloseResult> {
		return okClose();
	}
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("RetryAppendSession is not wedged by a non-finite meteredBytes record", () => {
	it("drains a legitimate waiter after a NaN-metered record is recomputed at the boundary", async () => {
		const transport = new HeldAckTransport();
		const session = await AppendSessionImpl.create(
			async () => transport,
			// 1 MiB floor: a single ~1 MiB batch fills all in-flight capacity,
			// so a second submit parks until the first is acknowledged.
			{ maxInflightBytes: MAX_APPEND_BYTES },
		);

		// Fill capacity with a held, unacked batch A (exactly 1 MiB).
		const ticketA = await session.submit(
			AppendInput.create([
				AppendRecord.bytes({ body: new Uint8Array(MAX_APPEND_BYTES - 8) }),
			]),
		);
		await flush(); // let the pump submit A to the transport

		// A NaN-metered record is recomputed at the boundary, so it never
		// reaches the session as a NaN capacity request that would park
		// forever at the head of `capacityWaiters`.
		const recomputedNan = AppendInput.create([
			{ body: "x", meteredBytes: Number.NaN } as any,
		]);
		expect(Number.isFinite(recomputedNan.meteredBytes)).toBe(true);

		// A legitimate submit parks behind A (capacity is full).
		const waiterP = session.submit(
			AppendInput.create([AppendRecord.string({ body: "ok" })]),
		);
		let parked = false;
		waiterP.then(() => {
			parked = true;
		});
		await flush();
		expect(parked).toBe(false);

		// Release A. The legitimate waiter must drain — there is no NaN
		// head blocking the queue.
		transport.ackNext(0, 1);
		await flush();
		const ticketB = await waiterP; // would hang forever if a NaN waiter were ahead
		await flush(); // let the pump submit B to the transport
		transport.ackNext(1, 1);
		const ack = await ticketB.ack();
		expect(ack.end.seqNum).toBe(2);

		// ticketA.ack() resolves silently (suppress any rejection noise).
		await ticketA.ack().catch(() => {});
		await session.close();
	}, 5000);
});
