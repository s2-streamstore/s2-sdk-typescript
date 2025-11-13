import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { S2Error } from "../error.js";
import type { AppendAck, StreamPosition } from "../generated/index.js";
import type { AppendResult, CloseResult } from "../lib/result.js";
import { err, errClose, ok, okClose } from "../lib/result.js";
import { AppendSession as AppendSessionImpl } from "../lib/retry.js";
import type {
	AcksStream,
	AppendArgs,
	AppendRecord,
	TransportAppendSession,
} from "../lib/stream/types.js";

/**
 * Minimal controllable AppendSession for testing AppendSessionImpl.
 */
class FakeAppendSession {
	public readonly readable: ReadableStream<AppendAck>;
	public readonly writable: WritableStream<AppendArgs>;
	private acksController!: ReadableStreamDefaultController<AppendAck>;
	private closed = false;
	public writes: AppendArgs[] = [];

	failureCause(): undefined {
		return undefined;
	}

	constructor(
		private readonly behavior: {
			rejectWritesWith?: S2Error; // if provided, writer.write rejects with this error
			neverAck?: boolean; // if true, never emit acks
			errorAcksWith?: S2Error; // if provided, acks() stream errors after first write
		} = {},
	) {
		this.readable = new ReadableStream<AppendAck>({
			start: (c) => {
				this.acksController = c;
			},
		});

		this.writable = new WritableStream<AppendArgs>({
			write: async (args) => {
				if (this.closed) {
					throw new S2Error({ message: "AppendSession is closed" });
				}
				if (this.behavior.rejectWritesWith) {
					throw this.behavior.rejectWritesWith;
				}
				this.writes.push(args);

				// Optionally error the acks stream right after a write
				if (this.behavior.errorAcksWith) {
					queueMicrotask(() => {
						try {
							this.acksController.error(this.behavior.errorAcksWith);
						} catch {}
					});
				}

				// Optionally emit an ack immediately
				if (!this.behavior.neverAck && !this.behavior.errorAcksWith) {
					const count = Array.isArray(args.records) ? args.records.length : 1;
					const start = { seq_num: 0, timestamp: 0 } as StreamPosition;
					const end = { seq_num: count, timestamp: 0 } as StreamPosition;
					const tail = { seq_num: count, timestamp: 0 } as StreamPosition;
					const ack: AppendAck = { start, end, tail };
					this.acksController.enqueue(ack);
				}
			},
			close: async () => {
				this.closed = true;
				try {
					this.acksController.close();
				} catch {}
			},
			abort: async (reason) => {
				this.closed = true;
				try {
					this.acksController.error(
						reason instanceof S2Error
							? reason
							: new S2Error({ message: String(reason) }),
					);
				} catch {}
			},
		});
	}

	acks(): AcksStream {
		return this.readable as AcksStream;
	}

	async close(): Promise<void> {
		await this.writable.close();
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}

	submit(
		records: AppendRecord | AppendRecord[],
		_args?: Omit<AppendArgs, "records"> & { precalculatedSize?: number },
	): Promise<AppendAck> {
		const writer = this.writable.getWriter();
		const batch = Array.isArray(records) ? records : [records];
		return writer.write({ records: batch } as AppendArgs) as any;
	}

	lastAckedPosition(): AppendAck | undefined {
		return undefined;
	}
}

/**
 * Transport-level fake session that returns discriminated unions.
 * Used for testing AppendSessionImpl which wraps transport sessions.
 */
class FakeTransportAppendSession implements TransportAppendSession {
	public writes: Array<{ records: AppendRecord[]; args?: any }> = [];
	private closed = false;
	private ackIndex = 0;

	constructor(
		private readonly behavior: {
			submitError?: S2Error; // if provided, submit() returns error result
			closeError?: S2Error; // if provided, close() returns error result
			neverAck?: boolean; // if true, submit() hangs forever (for timeout tests)
			customAcks?: AppendAck[]; // if provided, return these acks in sequence
		} = {},
	) {}

	async submit(
		records: AppendRecord | AppendRecord[],
		args?: Omit<AppendArgs, "records"> & { precalculatedSize?: number },
	): Promise<AppendResult> {
		if (this.closed) {
			return err(new S2Error({ message: "session is closed", status: 400 }));
		}

		if (this.behavior.submitError) {
			return err(this.behavior.submitError);
		}

		if (this.behavior.neverAck) {
			// Hang forever (for timeout tests)
			return new Promise(() => {});
		}

		const batch = Array.isArray(records) ? records : [records];
		this.writes.push({ records: batch, args });

		// Return custom ack if provided
		if (
			this.behavior.customAcks &&
			this.ackIndex < this.behavior.customAcks.length
		) {
			const ack = this.behavior.customAcks[this.ackIndex++]!;
			return ok(ack);
		}

		// Return default successful ack
		const count = batch.length;
		const start = { seq_num: 0, timestamp: 0 } as StreamPosition;
		const end = { seq_num: count, timestamp: 0 } as StreamPosition;
		const tail = { seq_num: count, timestamp: 0 } as StreamPosition;
		const ack: AppendAck = { start, end, tail };
		return ok(ack);
	}

	async close(): Promise<CloseResult> {
		if (this.behavior.closeError) {
			return errClose(this.behavior.closeError);
		}
		this.closed = true;
		return okClose();
	}
}

describe("AppendSessionImpl (unit)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("aborts on ack timeout (~5s from enqueue) when no acks arrive", async () => {
		const session = await AppendSessionImpl.create(async () => {
			// Accept writes but never emit acks
			return new FakeTransportAppendSession({ neverAck: true });
		});
		(session as any).requestTimeoutMillis = 500;

		const ackP = session.submit([{ body: "x" }]);

		// Not yet timed out at 0.49s
		await vi.advanceTimersByTimeAsync(490);
		await Promise.resolve();
		let settled = false;
		ackP.then(() => (settled = true)).catch(() => (settled = true));
		await Promise.resolve();
		expect(settled).toBe(false);

		// Time out after ~0.5s
		await vi.advanceTimersByTimeAsync(20);
		await Promise.resolve();
		await expect(ackP).rejects.toMatchObject({ status: 408 });
	});

	it("recovers from send-phase transient error and resolves after recovery", async () => {
		// First session rejects writes; second accepts and acks immediately
		let call = 0;
		const session = await AppendSessionImpl.create(
			async () => {
				call++;
				if (call === 1) {
					return new FakeTransportAppendSession({
						submitError: new S2Error({ message: "boom", status: 500 }),
					});
				}
				return new FakeTransportAppendSession();
			},
			undefined,
			{
				retryBackoffDurationMillis: 1,
				maxAttempts: 2,
				appendRetryPolicy: "all",
			},
		);

		const p = session.submit([{ body: "x" }]);
		// Allow microtasks (acks error propagation) to run
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(10);
		await Promise.resolve();
		const ack = await p;
		expect(ack.end.seq_num - ack.start.seq_num).toBe(1);
	});

	it("fails immediately when retries are disabled and send-phase errors persist", async () => {
		const error = new S2Error({ message: "boom", status: 500 });
		const session = await AppendSessionImpl.create(
			async () => new FakeTransportAppendSession({ submitError: error }),
			undefined,
			{
				retryBackoffDurationMillis: 1,
				maxAttempts: 1,
				appendRetryPolicy: "all",
			},
		);

		const ackP = session.submit([{ body: "x" }]);
		await expect(ackP).rejects.toMatchObject({
			message: "Max attempts (1) exhausted: boom",
			status: 500,
		});
	});

	it("does not retry non-idempotent inflight under noSideEffects policy and exposes failure cause", async () => {
		const error = new S2Error({ message: "boom", status: 500 });
		const session = await AppendSessionImpl.create(
			async () => new FakeTransportAppendSession({ submitError: error }),
			undefined,
			{
				retryBackoffDurationMillis: 1,
				maxAttempts: 2,
				appendRetryPolicy: "noSideEffects",
			},
		);

		const p1 = session.submit([{ body: "x" }]);
		await expect(p1).rejects.toMatchObject({ status: 500 });
		expect(session.failureCause()).toMatchObject({ status: 500 });
	});

	it("abort rejects backlog and queued submissions with the abort error", async () => {
		const error = new S2Error({ message: "boom", status: 500 });
		const session = await AppendSessionImpl.create(
			async () => new FakeTransportAppendSession({ submitError: error }),
			undefined,
			{
				retryBackoffDurationMillis: 1,
				maxAttempts: 2,
				appendRetryPolicy: "noSideEffects",
			},
		);

		const p1 = session.submit([{ body: "a" }]);
		const p2 = session.submit([{ body: "b" }]);
		await expect(p1).rejects.toMatchObject({ status: 500 });
		await expect(p2).rejects.toMatchObject({ status: 500 });
	});

	it("detects non-monotonic sequence numbers and aborts with fatal error", async () => {
		// Create acks with non-monotonic sequence numbers
		// Each ack must have correct count (end - start = 1 for single record batches)
		const ack1: AppendAck = {
			start: { seq_num: 0, timestamp: 0 },
			end: { seq_num: 1, timestamp: 0 }, // count = 1
			tail: { seq_num: 1, timestamp: 0 },
		};
		const ack2: AppendAck = {
			start: { seq_num: 0, timestamp: 0 }, // Decreasing!
			end: { seq_num: 1, timestamp: 0 },
			tail: { seq_num: 1, timestamp: 0 },
		};

		const session = await AppendSessionImpl.create(
			async () => new FakeTransportAppendSession({ customAcks: [ack1, ack2] }),
			undefined,
			{ retryBackoffDurationMillis: 1, maxAttempts: 1 }, // No retries
		);

		// First submit should succeed
		const p1 = session.submit([{ body: "a" }]);
		await expect(p1).resolves.toMatchObject({ end: { seq_num: 1 } });

		// Second submit should trigger invariant violation
		const p2 = session.submit([{ body: "b" }]);
		await expect(p2).rejects.toMatchObject({
			message: expect.stringContaining(
				"Sequence number not strictly increasing",
			),
			status: 500,
			code: "INTERNAL_ERROR",
		});

		// Session should expose the failure cause
		expect(session.failureCause()).toMatchObject({
			message: expect.stringContaining(
				"Sequence number not strictly increasing",
			),
			status: 500,
		});

		// Subsequent submits should also fail
		const p3 = session.submit([{ body: "c" }]);
		await expect(p3).rejects.toMatchObject({ status: 500 });
	});

	it("detects non-increasing (equal) sequence numbers and aborts", async () => {
		// Create acks with equal sequence numbers
		// Each ack must have correct count (end - start = 1 for single record batches)
		const ack1: AppendAck = {
			start: { seq_num: 9, timestamp: 0 },
			end: { seq_num: 10, timestamp: 0 }, // count = 1
			tail: { seq_num: 10, timestamp: 0 },
		};
		const ack2: AppendAck = {
			start: { seq_num: 9, timestamp: 0 },
			end: { seq_num: 10, timestamp: 0 }, // Equal end, not increasing!
			tail: { seq_num: 10, timestamp: 0 },
		};

		const session = await AppendSessionImpl.create(
			async () => new FakeTransportAppendSession({ customAcks: [ack1, ack2] }),
			undefined,
			{ retryBackoffDurationMillis: 1, maxAttempts: 1 },
		);

		// First submit should succeed
		await expect(session.submit([{ body: "a" }])).resolves.toMatchObject({
			end: { seq_num: 10 },
		});

		// Second submit should trigger invariant violation
		const error = await session.submit([{ body: "b" }]).catch((e) => e);
		expect(error.message).toContain("Sequence number not strictly increasing");
		expect(error.message).toContain("previous=10");
		expect(error.message).toContain("current=10");
		expect(error.status).toBe(500);
	});
});
