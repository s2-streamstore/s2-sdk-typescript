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
import { withinDeadline } from "./helpers.js";

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

	constructor(
		private readonly behavior: {
			submitError?: S2Error; // if provided, submit() returns error result
			closeError?: S2Error; // if provided, close() returns error result
			neverAck?: boolean; // if true, submit() hangs forever (for timeout tests)
			customAcks?: AppendAck[]; // if provided, return these acks in sequence
			unsent?: boolean; // if true, batches fail before reaching the server
		} = {},
	) {}

	async submit(input: AppendInput, onSend?: () => void): Promise<AppendResult> {
		if (this.closed) {
			return err(new S2Error({ message: "session is closed", status: 400 }));
		}

		if (!this.behavior.unsent) {
			onSend?.();
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
			return ok(ack);
		}

		// Return default successful ack
		const count = batch.length;
		const start: StreamPosition = { seqNum: 0, timestamp: new Date(0) };
		const end: StreamPosition = { seqNum: count, timestamp: new Date(0) };
		const tail: StreamPosition = { seqNum: count, timestamp: new Date(0) };
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

	it("keeps submit order when a later batch would fit before one waiting for capacity", async () => {
		vi.useRealTimers();
		const position = (seqNum: number) => ({ seqNum, timestamp: new Date(0) });
		const transport = new FakeTransportAppendSession({
			customAcks: [0, 1, 2].map((n) => ({
				start: position(n),
				end: position(n + 1),
				tail: position(n + 1),
			})),
		});
		const session = await AppendSessionImpl.create(async () => transport, {
			maxInflightBytes: 1024 * 1024,
		});
		const batch = (body: string) =>
			AppendInput.create([AppendRecord.string({ body })]);

		// The second waits for capacity, which the third would fit in.
		const tickets = await withinDeadline(
			Promise.all([
				session.submit(batch("a".repeat(600 * 1024))),
				session.submit(batch("b".repeat(600 * 1024))),
				session.submit(batch("c")),
			]),
		);
		await withinDeadline(Promise.all(tickets.map((ticket) => ticket.ack())));
		expect(
			transport.writes.map(({ records }) => String(records[0]!.body)[0]),
		).toEqual(["a", "b", "c"]);
	});

	// Detail bug_54158d21: a rejected transport submit() crashed the pump, so
	// the session hung with no error.
	it("fails the session when the transport's submit() rejects", async () => {
		vi.useRealTimers();
		const session = await AppendSessionImpl.create(
			async () => ({
				submit: async () => {
					throw new Error("Message too large");
				},
				close: async () => okClose(),
			}),
			undefined,
			{ minBaseDelayMillis: 1, maxBaseDelayMillis: 1 },
		);

		const ticket = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "x" })]),
		);
		await expect(withinDeadline(ticket.ack())).rejects.toMatchObject({
			code: "SESSION_CLOSED",
		});
		expect(session.failureCause()?.message).toContain("Message too large");
		await expect(withinDeadline(session.close())).rejects.toThrow(
			"Message too large",
		);
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

	it("retries under noSideEffects when the failing attempt never sent the batch", async () => {
		let call = 0;
		const session = await AppendSessionImpl.create(
			async () => {
				call++;
				if (call === 1) {
					// Sent, but rejected with no side effects.
					return new FakeTransportAppendSession({
						submitError: new S2Error({
							message: "rate limited",
							status: 429,
							code: "rate_limited",
							origin: "server",
						}),
					});
				}
				if (call === 2) {
					// Fails unsent: the first attempt's send must not count.
					return new FakeTransportAppendSession({
						submitError: new S2Error({
							message: "stream closed",
							status: 502,
							origin: "server",
						}),
						unsent: true,
					});
				}
				return new FakeTransportAppendSession();
			},
			undefined,
			{
				minBaseDelayMillis: 1,
				maxBaseDelayMillis: 1,
				maxAttempts: 3,
				appendRetryPolicy: "noSideEffects",
			},
		);

		const p = session.submit(
			AppendInput.create([AppendRecord.string({ body: "x" })]),
		);
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(20);
		await Promise.resolve();
		const ticket = await p;
		const ack = await ticket.ack();
		expect(ack.end.seqNum - ack.start.seqNum).toBe(1);
	});

	it("does not retry under noSideEffects when the transport sent the batch", async () => {
		const error = new S2Error({
			message: "stream closed",
			status: 502,
			origin: "server",
		});
		const session = await AppendSessionImpl.create(
			async () =>
				new FakeTransportAppendSession({
					submitError: error, // Sent, so a mutation may have occurred
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
