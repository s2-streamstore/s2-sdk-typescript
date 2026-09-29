import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppendIndefiniteFailureError, S2Error } from "../error.js";
import { AppendInput, AppendRecord } from "../index.js";
import type { AppendResult, CloseResult } from "../lib/result.js";
import { err, errClose, ok, okClose } from "../lib/result.js";
import { RetryAppendSession as AppendSessionImpl } from "../lib/retry.js";
import type {
	AcksStream,
	TransportAppendSession,
} from "../lib/stream/types.js";
import type { AppendAck, StreamPosition } from "../types.js";

/**
 * Minimal controllable AppendSession for testing AppendSessionImpl.
 */
class FakeAppendSession {
	public readonly readable: ReadableStream<AppendAck>;
	public readonly writable: WritableStream<AppendInput>;
	private acksController!: ReadableStreamDefaultController<AppendAck>;
	private closed = false;
	public writes: AppendInput[] = [];

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

		this.writable = new WritableStream<AppendInput>({
			write: async (input) => {
				if (this.closed) {
					throw new S2Error({ message: "AppendSession is closed" });
				}
				if (this.behavior.rejectWritesWith) {
					throw this.behavior.rejectWritesWith;
				}
				this.writes.push(input);

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
					const batch = Array.isArray(input.records)
						? input.records
						: [input.records];
					const count = batch.length;
					const start: StreamPosition = { seqNum: 0, timestamp: new Date(0) };
					const end: StreamPosition = { seqNum: count, timestamp: new Date(0) };
					const tail: StreamPosition = {
						seqNum: count,
						timestamp: new Date(0),
					};
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

	submit(input: AppendInput): Promise<AppendAck> {
		const writer = this.writable.getWriter();
		return writer.write(input) as any;
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
	private _effectSignalled = false;

	constructor(
		private readonly behavior: {
			submitError?: S2Error; // if provided, submit() returns error result
			closeError?: S2Error; // if provided, close() returns error result
			neverAck?: boolean; // if true, submit() hangs forever (for timeout tests)
			customAcks?: AppendAck[]; // if provided, return these acks in sequence
			effectSignalled?: boolean; // override effectSignalled() return value
		} = {},
	) {
		if (behavior.effectSignalled !== undefined) {
			this._effectSignalled = behavior.effectSignalled;
		}
	}

	effectSignalled(): boolean {
		return this._effectSignalled;
	}

	async submit(input: AppendInput): Promise<AppendResult> {
		if (this.closed) {
			return err(new S2Error({ message: "session is closed", status: 400 }));
		}

		// Signal effect unless explicitly overridden by behavior
		if (this.behavior.effectSignalled === undefined) {
			this._effectSignalled = true;
		}

		if (this.behavior.submitError) {
			return err(this.behavior.submitError);
		}

		if (this.behavior.neverAck) {
			// Hang forever (for timeout tests)
			return new Promise(() => {});
		}

		const batch = Array.isArray(input.records)
			? input.records
			: [input.records];
		this.writes.push({
			records: batch,
			args: {
				matchSeqNum: input.matchSeqNum,
				fencingToken: input.fencingToken,
			},
		});

		// Return custom ack if provided
		if (
			this.behavior.customAcks &&
			this.ackIndex < this.behavior.customAcks.length
		) {
			const ack = this.behavior.customAcks[this.ackIndex++]!;
			// Reset effect signal on successful ack (simulates dormancy)
			this._effectSignalled = false;
			return ok(ack);
		}

		// Return default successful ack
		const count = batch.length;
		const start: StreamPosition = { seqNum: 0, timestamp: new Date(0) };
		const end: StreamPosition = { seqNum: count, timestamp: new Date(0) };
		const tail: StreamPosition = { seqNum: count, timestamp: new Date(0) };
		const ack: AppendAck = { start, end, tail };
		// Reset effect signal on successful ack (simulates dormancy)
		this._effectSignalled = false;
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

/** A non-retryable error that the SDK regards as definite. */
class DefiniteTerminalError extends S2Error {
	constructor() {
		super({
			message: "permission denied",
			status: 403,
			code: "permission_denied",
			origin: "server",
		});
	}

	override hasNoSideEffects(): boolean {
		return true;
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
		const session = await AppendSessionImpl.create(
			async () => {
				// Accept writes but never emit acks
				return new FakeTransportAppendSession({ neverAck: true });
			},
			undefined,
			{ maxAttempts: 1 }, // Disable retries for this test
		);
		(session as any).requestTimeoutMillis = 500;

		const ticketP = session.submit(
			AppendInput.create([AppendRecord.string({ body: "x" })]),
		);
		const ticket = await ticketP;
		const ackP = ticket.ack();

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
				minBaseDelayMillis: 1,
				maxBaseDelayMillis: 1,
				maxAttempts: 2,
				appendRetryPolicy: "all",
			},
		);

		const p = session.submit(
			AppendInput.create([AppendRecord.string({ body: "x" })]),
		);
		// Allow microtasks (acks error propagation) to run
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(10);
		await Promise.resolve();
		const ticket = await p;
		const ack = await ticket.ack();
		expect(ack.end.seqNum - ack.start.seqNum).toBe(1);
	});

	it("fails immediately when retries are disabled and send-phase errors persist", async () => {
		const error = new S2Error({ message: "boom", status: 500 });
		const session = await AppendSessionImpl.create(
			async () => new FakeTransportAppendSession({ submitError: error }),
			undefined,
			{
				minBaseDelayMillis: 1,
				maxBaseDelayMillis: 1,
				maxAttempts: 1,
				appendRetryPolicy: "all",
			},
		);

		const ticket = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "x" })]),
		);
		await expect(ticket.ack()).rejects.toMatchObject({
			message: "Max attempts (1) exhausted: boom",
			status: 500,
		});
	});

	it("does not retry under noSideEffects policy when error may have side effects", async () => {
		const error = new S2Error({
			message: "boom",
			status: 500,
			origin: "server",
		});
		const session = await AppendSessionImpl.create(
			async () => new FakeTransportAppendSession({ submitError: error }),
			undefined,
			{
				minBaseDelayMillis: 1,
				maxBaseDelayMillis: 1,
				maxAttempts: 2,
				appendRetryPolicy: "noSideEffects",
			},
		);

		const ticket1 = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "x" })]),
		);
		await expect(ticket1.ack()).rejects.toMatchObject({ status: 500 });
		expect(session.failureCause()).toMatchObject({ status: 500 });
	});

	it("preserves uncertainty for a batch whose earlier attempt may have taken effect", async () => {
		let call = 0;
		const session = await AppendSessionImpl.create(
			async () => {
				call++;
				if (call === 1) {
					return new FakeTransportAppendSession({
						submitError: new S2Error({
							message: "unavailable",
							status: 503,
							code: "unavailable",
							origin: "server",
						}),
					});
				}
				return new FakeTransportAppendSession({
					submitError: new DefiniteTerminalError(),
				});
			},
			undefined,
			{
				minBaseDelayMillis: 1,
				maxBaseDelayMillis: 1,
				maxAttempts: 3,
				appendRetryPolicy: "all",
			},
		);

		const ticket = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "x" })]),
		);
		const ackP = ticket.ack();
		ackP.catch(() => {});
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(10);
		await Promise.resolve();

		const error: unknown = await ackP.catch((e) => e);
		expect(error).toBeInstanceOf(AppendIndefiniteFailureError);
		const indefinite = error as AppendIndefiniteFailureError;
		expect(indefinite.hasNoSideEffects()).toBe(false);
		expect(indefinite.finalAttemptError.status).toBe(403);
		expect(session.failureCause()).toBeInstanceOf(AppendIndefiniteFailureError);
	});

	it("retries under noSideEffects policy when error guarantees no mutation (rate_limited)", async () => {
		let call = 0;
		const session = await AppendSessionImpl.create(
			async () => {
				call++;
				if (call === 1) {
					return new FakeTransportAppendSession({
						submitError: new S2Error({
							message: "rate limited",
							status: 429,
							code: "rate_limited",
							origin: "server",
						}),
					});
				}
				return new FakeTransportAppendSession();
			},
			undefined,
			{
				minBaseDelayMillis: 1,
				maxBaseDelayMillis: 1,
				maxAttempts: 2,
				appendRetryPolicy: "noSideEffects",
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
	});

	it("retries under noSideEffects when transport reports no effect signalled (dormant)", async () => {
		let call = 0;
		const session = await AppendSessionImpl.create(
			async () => {
				call++;
				if (call === 1) {
					// Transport that errors but reports no effect was signalled (dormant)
					return new FakeTransportAppendSession({
						submitError: new S2Error({
							message: "stream closed",
							status: 502,
							origin: "server",
						}),
						effectSignalled: false, // No data was sent
					});
				}
				return new FakeTransportAppendSession();
			},
			undefined,
			{
				minBaseDelayMillis: 1,
				maxBaseDelayMillis: 1,
				maxAttempts: 2,
				appendRetryPolicy: "noSideEffects",
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
	});

	it("does not retry under noSideEffects when transport reports effect signalled", async () => {
		const error = new S2Error({
			message: "stream closed",
			status: 502,
			origin: "server",
		});
		const session = await AppendSessionImpl.create(
			async () =>
				new FakeTransportAppendSession({
					submitError: error,
					effectSignalled: true, // Data was sent, mutation may have occurred
				}),
			undefined,
			{
				minBaseDelayMillis: 1,
				maxBaseDelayMillis: 1,
				maxAttempts: 2,
				appendRetryPolicy: "noSideEffects",
			},
		);

		const ticket = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "x" })]),
		);
		await expect(ticket.ack()).rejects.toMatchObject({ status: 502 });
		expect(session.failureCause()).toMatchObject({ status: 502 });
	});

	it("reconnects on server_draining without spending the retry budget under noSideEffects", async () => {
		const sessions: FakeTransportAppendSession[] = [];
		const session = await AppendSessionImpl.create(
			async () => {
				const s =
					sessions.length < 2
						? new FakeTransportAppendSession({
								submitError: new S2Error({
									message: "server draining",
									status: 503,
									code: "server_draining",
									origin: "server",
								}),
								// Data reached the wire; only the drain contract makes this safe.
								effectSignalled: true,
							})
						: new FakeTransportAppendSession();
				sessions.push(s);
				return s;
			},
			undefined,
			{
				minBaseDelayMillis: 1,
				maxBaseDelayMillis: 1,
				maxAttempts: 1,
				appendRetryPolicy: "noSideEffects",
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
		expect(sessions[2]!.writes).toHaveLength(1);
		expect(session.failureCause()).toBeUndefined();
	});

	it("detects non-monotonic sequence numbers and aborts with fatal error", async () => {
		// Create acks with non-monotonic sequence numbers
		// Each ack must have correct count (end - start = 1 for single record batches)
		const ack1: AppendAck = {
			start: { seqNum: 0, timestamp: new Date(0) },
			end: { seqNum: 1, timestamp: new Date(0) }, // count = 1
			tail: { seqNum: 1, timestamp: new Date(0) },
		};
		const ack2: AppendAck = {
			start: { seqNum: 0, timestamp: new Date(0) }, // Decreasing!
			end: { seqNum: 1, timestamp: new Date(0) },
			tail: { seqNum: 1, timestamp: new Date(0) },
		};

		const session = await AppendSessionImpl.create(
			async () => new FakeTransportAppendSession({ customAcks: [ack1, ack2] }),
			undefined,
			{ minBaseDelayMillis: 1, maxBaseDelayMillis: 1, maxAttempts: 1 }, // No retries
		);

		// First submit should succeed
		const ticket1 = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "a" })]),
		);
		await expect(ticket1.ack()).resolves.toMatchObject({
			end: { seqNum: 1 },
		});

		// Second submit should trigger invariant violation
		const ticket2 = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "b" })]),
		);
		await expect(ticket2.ack()).rejects.toMatchObject({
			message: expect.stringContaining(
				"Sequence number not strictly increasing",
			),
			status: 0,
			code: "INTERNAL_ERROR",
		});

		// Session should expose the failure cause
		expect(session.failureCause()).toMatchObject({
			message: expect.stringContaining(
				"Sequence number not strictly increasing",
			),
			status: 0,
		});

		// Subsequent submits should also fail
		await expect(
			session.submit(AppendInput.create([AppendRecord.string({ body: "c" })])),
		).rejects.toMatchObject({
			status: 0,
		});
	});

	it("detects non-increasing (equal) sequence numbers and aborts", async () => {
		// Create acks with equal sequence numbers
		// Each ack must have correct count (end - start = 1 for single record batches)
		const ack1: AppendAck = {
			start: { seqNum: 9, timestamp: new Date(0) },
			end: { seqNum: 10, timestamp: new Date(0) }, // count = 1
			tail: { seqNum: 10, timestamp: new Date(0) },
		};
		const ack2: AppendAck = {
			start: { seqNum: 9, timestamp: new Date(0) },
			end: { seqNum: 10, timestamp: new Date(0) }, // Equal end, not increasing!
			tail: { seqNum: 10, timestamp: new Date(0) },
		};

		const session = await AppendSessionImpl.create(
			async () => new FakeTransportAppendSession({ customAcks: [ack1, ack2] }),
			undefined,
			{ minBaseDelayMillis: 1, maxBaseDelayMillis: 1, maxAttempts: 1 },
		);

		// First submit should succeed
		const ticket1 = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "a" })]),
		);
		await expect(ticket1.ack()).resolves.toMatchObject({
			end: { seqNum: 10 },
		});

		// Second submit should trigger invariant violation
		const ticket2 = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "b" })]),
		);
		const error = await ticket2.ack().catch((e) => e);
		expect(error.message).toContain("Sequence number not strictly increasing");
		expect(error.message).toContain("previous=10");
		expect(error.message).toContain("current=10");
		expect(error.status).toBe(0);
	});
});

describe("RetryAppendSession late-batch abort classification", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/** Drive fake timers + microtasks until `p` settles (or steps run out). */
	async function settle<T>(p: Promise<T>, steps = 40): Promise<void> {
		let settled = false;
		p.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		for (let i = 0; i < steps && !settled; i++) {
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(5);
			await Promise.resolve();
		}
	}

	/**
	 * Build a session that, under the default "all" policy, drives the
	 * max-attempts abort path with a prior indefinite (uncertain) attempt
	 * followed by a final `hasNoSideEffects()` error. Attempt 1 is a 503
	 * `unavailable` (server-origin, side-effecting, retryable) which marks the
	 * inflight batch as `priorUncertainty=true`; intermediate attempts are
	 * `429 rate_limited` (server-origin, `hasNoSideEffects()===true`, retryable)
	 * which do not mark; the final attempt is `ECONNREFUSED` (sdk-origin,
	 * `hasNoSideEffects()===true`), which exhausts the budget and triggers
	 * `abort(wrappedError)`.
	 */
	async function buildUncertainAbortSession(maxAttempts: number) {
		let call = 0;
		const session = await AppendSessionImpl.create(
			async () => {
				call++;
				if (call === 1) {
					return new FakeTransportAppendSession({
						submitError: new S2Error({
							message: "unavailable",
							status: 503,
							code: "unavailable",
							origin: "server",
						}),
					});
				}
				if (call < maxAttempts) {
					return new FakeTransportAppendSession({
						submitError: new S2Error({
							message: "rate limited",
							status: 429,
							code: "rate_limited",
							origin: "server",
						}),
					});
				}
				return new FakeTransportAppendSession({
					submitError: new S2Error({
						message: "connect refused",
						status: 502,
						code: "ECONNREFUSED",
						origin: "sdk",
					}),
				});
			},
			undefined,
			{
				minBaseDelayMillis: 1,
				maxBaseDelayMillis: 1,
				maxAttempts,
				appendRetryPolicy: "all",
			},
		);
		return { session };
	}

	it("returns the plain final error to a never-sent late batch (maxAttempts: 2, default policy)", async () => {
		const { session } = await buildUncertainAbortSession(2);

		const ticketA = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "a" })]),
		);
		const ackP = ticketA.ack();
		await settle(ackP);

		// Batch A was transmitted and its earlier attempt was indefinite, so it
		// keeps the per-batch AppendIndefiniteFailureError classification.
		const errorA = (await ackP.catch((e) => e)) as AppendIndefiniteFailureError;
		expect(errorA).toBeInstanceOf(AppendIndefiniteFailureError);
		expect(errorA.hasNoSideEffects()).toBe(false);
		expect(errorA.finalAttemptError.code).toBe("ECONNREFUSED");
		expect(errorA.finalAttemptError.status).toBe(502);
		expect(errorA.finalAttemptError.message).toContain(
			"Max attempts (2) exhausted",
		);
		expect(errorA.finalAttemptError.message).toContain("connect refused");

		// Batch B is submitted after the fatal abort — it was never sent on the
		// wire, so it must receive the plain final error, not the wrapped one.
		const errorB = await session
			.submit(AppendInput.create([AppendRecord.string({ body: "b" })]))
			.catch((e) => e);

		expect(errorB).not.toBeInstanceOf(AppendIndefiniteFailureError);
		expect(errorB).toBeInstanceOf(S2Error);
		expect((errorB as S2Error).hasNoSideEffects()).toBe(true);
		expect((errorB as S2Error).code).toBe("ECONNREFUSED");
		expect((errorB as S2Error).status).toBe(502);
		expect((errorB as S2Error).message).toContain("Max attempts (2) exhausted");
		// The late batch receives exactly the final-attempt error the wrapper
		// carries — not a fresh copy, not the wrapped class.
		expect(errorB).toBe(errorA.finalAttemptError);

		// Session-level reporting keeps the wrapped error.
		const cause = session.failureCause() as AppendIndefiniteFailureError;
		expect(cause).toBeInstanceOf(AppendIndefiniteFailureError);
		expect(cause.hasNoSideEffects()).toBe(false);
		expect(cause.finalAttemptError).toBe(errorB);
	});

	it("submitInternal fast-fail returns the plain final error for a never-sent batch", async () => {
		const { session } = await buildUncertainAbortSession(2);
		const ticketA = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "a" })]),
		);
		const ackP = ticketA.ack();
		await settle(ackP);
		await ackP.catch(() => {});

		// Directly exercise the submitInternal fast-fail path (bypassing
		// waitForCapacity), as would be hit in the narrow race where capacity
		// was reserved before abort set fatalError — the batch is never sent.
		const input = AppendInput.create([AppendRecord.string({ body: "z" })]);
		const result: AppendResult = await (
			session as unknown as {
				submitInternal: (
					input: AppendInput,
					size: number,
				) => Promise<AppendResult>;
			}
		).submitInternal(input, input.meteredBytes);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).not.toBeInstanceOf(AppendIndefiniteFailureError);
			expect(result.error.hasNoSideEffects()).toBe(true);
			expect(result.error.code).toBe("ECONNREFUSED");
			expect(result.error.message).toContain("Max attempts (2) exhausted");
		}
	});

	it("errors the acks stream with the session-level AppendIndefiniteFailureError", async () => {
		const { session } = await buildUncertainAbortSession(2);
		const ticketA = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "a" })]),
		);
		const ackP = ticketA.ack();
		await settle(ackP);
		await ackP.catch(() => {});

		const reader = session.acks().getReader();
		try {
			const acksErr = await reader.read().catch((e) => e);
			expect(acksErr).toBeInstanceOf(AppendIndefiniteFailureError);
			expect((acksErr as AppendIndefiniteFailureError).hasNoSideEffects()).toBe(
				false,
			);
		} finally {
			try {
				reader.releaseLock();
			} catch {}
		}
	});
});
