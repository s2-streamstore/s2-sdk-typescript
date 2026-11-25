import { describe, expect, it, vi } from "vitest";
import { BatchTransform } from "../batch-transform.js";
import { S2Error } from "../error.js";
import { AppendRecord } from "../index.js";
import type { AppendResult, CloseResult } from "../lib/result.js";
import { ok, okClose } from "../lib/result.js";
import { RetryAppendSession } from "../lib/retry.js";
import {
	type AcksStream,
	type AppendRecord as AppendRecordType,
	type AppendSession,
	BatchSubmitTicket,
	type TransportAppendSession,
} from "../lib/stream/types.js";
import { Producer } from "../producer.js";
import { type AppendAck, type AppendInput } from "../types.js";
import { waitFor, withinDeadline } from "./helpers.js";

class MockAppendSession implements AppendSession {
	readonly readable = new ReadableStream<AppendAck>();
	readonly writable = new WritableStream<AppendInput>();
	private readonly acksStream: AcksStream =
		new ReadableStream<AppendAck>() as AcksStream;

	private readonly received: string[] = [];
	private seq = 0;
	private closed = false;

	async submit(input: AppendInput): Promise<BatchSubmitTicket> {
		if (this.closed) {
			throw new Error("session closed");
		}

		const batch = Array.isArray(input.records)
			? input.records
			: [input.records];
		for (const record of batch) {
			if (typeof record.body !== "string") {
				throw new Error("expected string body in test harness");
			}
			this.received.push(record.body);
		}

		const ack: AppendAck = {
			start: { seqNum: this.seq, timestamp: new Date(0) },
			end: { seqNum: this.seq + batch.length, timestamp: new Date(0) },
			tail: { seqNum: this.seq + batch.length, timestamp: new Date(0) },
		};

		this.seq += batch.length;

		return new BatchSubmitTicket(Promise.resolve(ack), 0, batch.length);
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	acks(): AcksStream {
		return this.acksStream;
	}

	lastAckedPosition(): AppendAck | undefined {
		return undefined;
	}

	failureCause(): undefined {
		return undefined;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}

	getValues(): string[] {
		return this.received;
	}
}

class AsyncMockAppendSession implements AppendSession {
	readonly readable = new ReadableStream<AppendAck>();
	readonly writable = new WritableStream<AppendInput>();
	private readonly acksStream: AcksStream =
		new ReadableStream<AppendAck>() as AcksStream;

	private readonly received: string[] = [];
	private seq = 0;
	private closed = false;
	private callCount = 0;

	async submit(input: AppendInput): Promise<BatchSubmitTicket> {
		if (this.closed) {
			throw new Error("session closed");
		}

		const batch = Array.isArray(input.records)
			? input.records
			: [input.records];
		for (const record of batch) {
			if (typeof record.body !== "string") {
				throw new Error("expected string body in test harness");
			}
		}

		const submitDelay = this.callCount === 0 ? 10 : 0;
		this.callCount += 1;
		const ackDelay = submitDelay + 5;

		return new Promise<BatchSubmitTicket>((resolve) => {
			setTimeout(() => {
				const start = this.seq;
				for (const record of batch) {
					this.received.push(record.body as string);
				}
				this.seq += batch.length;
				const ackPromise = new Promise<AppendAck>((ackResolve) => {
					setTimeout(() => {
						ackResolve({
							start: { seqNum: start, timestamp: new Date(0) },
							end: { seqNum: this.seq, timestamp: new Date(0) },
							tail: { seqNum: this.seq, timestamp: new Date(0) },
						});
					}, ackDelay);
				});
				resolve(new BatchSubmitTicket(ackPromise, 0, batch.length));
			}, submitDelay);
		});
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	acks(): AcksStream {
		return this.acksStream;
	}

	lastAckedPosition(): AppendAck | undefined {
		return undefined;
	}

	failureCause(): undefined {
		return undefined;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}

	getValues(): string[] {
		return this.received;
	}
}

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

type PendingSubmission = {
	input: AppendInput;
	ack: Deferred<AppendAck>;
};

class ControlledAppendSession implements AppendSession {
	readonly readable = new ReadableStream<AppendAck>();
	readonly writable = new WritableStream<AppendInput>();
	private readonly acksStream = new ReadableStream<AppendAck>() as AcksStream;
	private readonly pendingSubmissions: PendingSubmission[] = [];
	private readonly submissionWaiters: Array<
		(submission: PendingSubmission) => void
	> = [];
	private readonly submitFailure?: { submitNumber: number; error: S2Error };

	submissionCount = 0;

	constructor(submitFailure?: { submitNumber: number; error: S2Error }) {
		this.submitFailure = submitFailure;
	}

	async submit(input: AppendInput): Promise<BatchSubmitTicket> {
		const submission = { input, ack: deferred<AppendAck>() };
		this.submissionCount += 1;
		const waiter = this.submissionWaiters.shift();
		if (waiter) {
			waiter(submission);
		} else {
			this.pendingSubmissions.push(submission);
		}

		if (this.submitFailure?.submitNumber === this.submissionCount) {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			throw this.submitFailure.error;
		}

		return new BatchSubmitTicket(
			submission.ack.promise,
			0,
			input.records.length,
		);
	}

	nextSubmission(): Promise<PendingSubmission> {
		const submission = this.pendingSubmissions.shift();
		if (submission) {
			return Promise.resolve(submission);
		}
		return new Promise((resolve) => this.submissionWaiters.push(resolve));
	}

	async close(): Promise<void> {}

	acks(): AcksStream {
		return this.acksStream;
	}

	lastAckedPosition(): AppendAck | undefined {
		return undefined;
	}

	failureCause(): S2Error | undefined {
		return this.submitFailure?.error;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}
}

function makeAck(startSeqNum: number, recordCount: number): AppendAck {
	return {
		start: { seqNum: startSeqNum, timestamp: new Date(0) },
		end: { seqNum: startSeqNum + recordCount, timestamp: new Date(0) },
		tail: { seqNum: startSeqNum + recordCount, timestamp: new Date(0) },
	};
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
	const pending = Symbol("pending");
	const state = await Promise.race([
		promise.then(
			() => "fulfilled" as const,
			() => "rejected" as const,
		),
		new Promise<typeof pending>((resolve) =>
			setTimeout(() => resolve(pending), 10),
		),
	]);
	expect(state).toBe(pending);
}

describe("Producer", () => {
	it("preserves record order when batching", async () => {
		const session = new MockAppendSession();
		const producer = new Producer(
			new BatchTransform({ lingerDurationMillis: 0, maxBatchRecords: 5 }),
			session,
		);

		const total = 100;
		for (let i = 0; i < total; i++) {
			await producer.submit(AppendRecord.string({ body: `rec-${i}` }));
		}

		await producer.close();

		expect(session.getValues()).toEqual(
			Array.from({ length: total }, (_v, i) => `rec-${i}`),
		);
	});

	it("rejects only the submit of an invalid hand-built record", async () => {
		const session = new MockAppendSession();
		const producer = new Producer(
			new BatchTransform({ lingerDurationMillis: 10, maxBatchRecords: 3 }),
			session,
		);

		await producer.submit(AppendRecord.string({ body: "a" }));
		await expect(
			producer.submit({
				body: "bad",
				timestamp: Number.NaN,
				meteredBytes: 11,
			} as AppendRecordType),
		).rejects.toBeInstanceOf(S2Error);
		await expect(
			producer.submit({
				body: new Uint8Array(2 * 1024 * 1024),
				meteredBytes: 10,
			} as AppendRecordType),
		).rejects.toBeInstanceOf(S2Error);
		await producer.submit(AppendRecord.string({ body: "b" }));
		await withinDeadline(producer.close());

		expect(session.getValues()).toEqual(["a", "b"]);
	});

	it("waits for appendSession submissions to preserve ordering", async () => {
		const session = new AsyncMockAppendSession();
		const producer = new Producer(
			new BatchTransform({
				lingerDurationMillis: 0,
				maxBatchRecords: 2,
				matchSeqNum: 0,
			}),
			session,
		);

		const submissions = [];
		for (let i = 0; i < 4; i++) {
			submissions.push(
				producer.submit(AppendRecord.string({ body: `rec-${i}` })),
			);
		}
		await Promise.all(submissions);

		await producer.close();
		await new Promise((resolve) => setTimeout(resolve, 25));

		expect(session.getValues()).toEqual(["rec-0", "rec-1", "rec-2", "rec-3"]);
	});

	it("flush emits the current partial batch and waits for all prior acks", async () => {
		const session = new ControlledAppendSession();
		const producer = new Producer(
			new BatchTransform({
				lingerDurationMillis: 60_000,
				maxBatchRecords: 2,
			}),
			session,
		);

		const tickets = await Promise.all([
			producer.submit(AppendRecord.string({ body: "a" })),
			producer.submit(AppendRecord.string({ body: "b" })),
			producer.submit(AppendRecord.string({ body: "c" })),
		]);
		const fullBatchSubmission = await session.nextSubmission();
		const flushPromise = producer.flush();
		const partialBatchSubmission = await session.nextSubmission();

		expect(fullBatchSubmission.input.records).toHaveLength(2);
		expect(partialBatchSubmission.input.records).toHaveLength(1);

		const fullBatchAck = makeAck(41, 2);
		fullBatchSubmission.ack.resolve(fullBatchAck);
		await Promise.all([tickets[0].ack(), tickets[1].ack()]);
		await expectPending(flushPromise);

		const partialBatchAck = makeAck(43, 1);
		partialBatchSubmission.ack.resolve(partialBatchAck);
		await flushPromise;

		const recordAcks = await Promise.all(tickets.map((ticket) => ticket.ack()));
		expect(recordAcks.map((ack) => ack.seqNum())).toEqual([41, 42, 43]);
		expect(recordAcks[0]?.batchAppendAck()).toBe(fullBatchAck);
		expect(recordAcks[1]?.batchAppendAck()).toBe(fullBatchAck);
		expect(recordAcks[2]?.batchAppendAck()).toBe(partialBatchAck);

		await producer.close();
	});

	it("flush is reusable, does nothing when empty, and excludes later submissions", async () => {
		const session = new ControlledAppendSession();
		const producer = new Producer(
			new BatchTransform({
				lingerDurationMillis: 60_000,
				maxBatchRecords: 100,
			}),
			session,
		);

		await producer.flush();
		expect(session.submissionCount).toBe(0);

		const firstTicket = await producer.submit(
			AppendRecord.string({ body: "before" }),
		);
		const firstFlushPromise = producer.flush();
		const firstSubmission = await session.nextSubmission();
		const laterTicketPromise = producer.submit(
			AppendRecord.string({ body: "after" }),
		);

		firstSubmission.ack.resolve(makeAck(0, 1));
		await firstFlushPromise;
		const laterTicket = await laterTicketPromise;
		expect((await firstTicket.ack()).seqNum()).toBe(0);
		expect(session.submissionCount).toBe(1);

		const secondFlushPromise = producer.flush();
		const secondSubmission = await session.nextSubmission();
		secondSubmission.ack.resolve(makeAck(1, 1));
		await secondFlushPromise;
		expect((await laterTicket.ack()).seqNum()).toBe(1);

		await producer.close();
	});

	it.each(["submit", "ack"] as const)(
		"flush propagates %s failures from prior submissions",
		async (failurePhase) => {
			const error = new S2Error({
				message: `${failurePhase} failed`,
				status: 412,
				origin: "server",
			});
			const session = new ControlledAppendSession(
				failurePhase === "submit" ? { submitNumber: 2, error } : undefined,
			);
			const producer = new Producer(
				new BatchTransform({
					lingerDurationMillis: 60_000,
					maxBatchRecords: 1,
				}),
				session,
			);

			const firstTicket = await producer.submit(
				AppendRecord.string({ body: "first" }),
			);
			const secondTicket = await producer.submit(
				AppendRecord.string({ body: "second" }),
			);
			const firstSubmission = await session.nextSubmission();
			const failingSubmission = await session.nextSubmission();
			const flushPromise = producer.flush();
			// A failed session settles every batch it accepted.
			firstSubmission.ack.reject(error);
			if (failurePhase === "ack") {
				failingSubmission.ack.reject(error);
			}

			await Promise.all([
				expect(firstTicket.ack()).rejects.toBe(error),
				// Never sent if the session rejected its batch.
				failurePhase === "submit"
					? expect(secondTicket.ack()).rejects.toMatchObject({
							code: "SESSION_CLOSED",
						})
					: expect(secondTicket.ack()).rejects.toBe(error),
				expect(flushPromise).rejects.toBe(error),
			]);
			await expect(producer.flush()).rejects.toBe(error);
			await expect(producer.close()).rejects.toBe(error);
		},
	);

	// Detail bug_9237d4a1-1b52-42bc-861a-9362ee04b6e0: close() dropped records
	// still queued in the writable and resolved successfully.
	it("close appends records already written to the writable and rejects later writes", async () => {
		const session = new MockAppendSession();
		const producer = new Producer(
			new BatchTransform({ lingerDurationMillis: 0, maxBatchRecords: 2 }),
			session,
		);
		const writer = producer.writable.getWriter();

		const writes = ["a", "b", "c"].map((body) =>
			writer.write(AppendRecord.string({ body })),
		);
		const closePromise = producer.close();
		const lateWrite = expect(
			writer.write(AppendRecord.string({ body: "late" })),
		).rejects.toMatchObject({ name: "S2Error", message: "Producer is closed" });

		await closePromise;
		expect(session.getValues()).toEqual(["a", "b", "c"]);
		await Promise.all(writes);
		await lateWrite;
	});

	it("flush covers records already written to the writable", async () => {
		const session = new MockAppendSession();
		const producer = new Producer(
			new BatchTransform({ lingerDurationMillis: 60_000 }),
			session,
		);
		const writer = producer.writable.getWriter();

		const writes = ["a", "b"].map((body) =>
			writer.write(AppendRecord.string({ body })),
		);
		await producer.flush();
		expect(session.getValues()).toEqual(["a", "b"]);

		await Promise.all(writes);
		await producer.close();
	});

	it.each<{
		name: string;
		session?: AppendSession;
		drop: (writer: WritableStreamDefaultWriter<AppendRecordType>) => void;
	}>([
		{
			name: "a write rejected after writer.close()",
			drop: (writer) => {
				void writer.write(AppendRecord.string({ body: "a" }));
				void writer.close();
				void writer.write(AppendRecord.string({ body: "x" })).catch(() => {});
			},
		},
		{
			name: "an abort with writes queued",
			drop: (writer) => {
				for (const body of ["a", "b", "c"]) {
					void writer.write(AppendRecord.string({ body })).catch(() => {});
				}
				void writer.abort("stop").catch(() => {});
			},
		},
		{
			name: "a failed sink write with writes queued",
			session: new ControlledAppendSession({
				submitNumber: 1,
				error: new S2Error({ message: "append failed", status: 500 }),
			}),
			drop: (writer) => {
				for (const body of ["a", "b", "c", "d", "e"]) {
					void writer.write(AppendRecord.string({ body })).catch(() => {});
				}
			},
		},
	])("close settles after $name", async ({ session, drop }) => {
		const producer = new Producer(
			new BatchTransform({ lingerDurationMillis: 0, maxBatchRecords: 1 }),
			session ?? new MockAppendSession(),
		);
		drop(producer.writable.getWriter());

		await withinDeadline(producer.close().catch(() => {}));
	});

	it("close ends a pipe into the writable", async () => {
		const producer = new Producer(
			new BatchTransform({ lingerDurationMillis: 0 }),
			new MockAppendSession(),
		);
		const piped = new ReadableStream<AppendRecordType>().pipeTo(
			producer.writable,
		);

		await producer.close();
		await expect(withinDeadline(piped)).rejects.toThrow("Producer is closed");
	});

	// Detail bug_5cd32435-2401-46c3-8ea3-ac956ef8d9cf: aborting or failing a
	// Producer while the pump is parked in a capacity-blocked session.submit()
	// let the parked batch append once capacity freed up and stalled close() for
	// the session's retry budget.
	describe("backpressure teardown with RetryAppendSession", () => {
		function createControllableTransport() {
			const sent: Array<{
				bodies: string[];
				ack: Deferred<AppendResult>;
			}> = [];
			const closeCalls: Array<{ cancel?: boolean } | undefined> = [];
			let seq = 0;

			const transport: TransportAppendSession = {
				submit(input, onSend) {
					onSend();
					const bodies = input.records.map((r) => String(r.body));
					const ack = deferred<AppendResult>();
					sent.push({ bodies, ack });
					return ack.promise;
				},
				async close(options): Promise<CloseResult> {
					closeCalls.push(options);
					return okClose();
				},
			};

			const ackNext = (index: number) => {
				const entry = sent[index];
				if (!entry) return;
				const start = seq;
				seq += entry.bodies.length;
				entry.ack.resolve(ok(makeAck(start, entry.bodies.length)));
			};

			return { transport, sent, closeCalls, ackNext };
		}

		it("writer.abort() under backpressure drops parked and blocked records and cancels inflight retries", async () => {
			const { transport, sent, closeCalls, ackNext } =
				createControllableTransport();
			const session = await RetryAppendSession.create(
				async () => transport,
				{ maxInflightBatches: 1 },
				{
					maxAttempts: 3,
					requestTimeoutMillis: 10_000,
					minBaseDelayMillis: 1,
					maxBaseDelayMillis: 1,
				},
			);
			const producer = new Producer(
				new BatchTransform({ lingerDurationMillis: 0, maxBatchRecords: 1 }),
				session,
			);
			const writer = producer.writable.getWriter();

			// r1 occupies the single inflight slot; r2 parks in session.submit()'s
			// capacityWaiters; r3 blocks inside writable's write() on backpressure.
			const r1 = await producer.submit(AppendRecord.string({ body: "r1" }));
			await waitFor(() => sent.length === 1);
			const r2 = await producer.submit(AppendRecord.string({ body: "r2" }));
			await waitFor(() => (session as any).capacityWaiters.length === 1);
			const r3Write = writer.write(AppendRecord.string({ body: "r3" })).then(
				() => undefined,
				(err: unknown) => err,
			);
			// Wait until r3 has entered submitInternal() and is parked on transform
			// backpressure before aborting.
			await waitFor(() => (producer as any).inflightRecords.length === 1);

			// Abort with a Symbol reason while r1 is held open (would stall 30s if
			// retried) and r3 is mid-write.
			const reason = Symbol("stop");
			await withinDeadline(writer.abort(reason));

			// Even if the transport later resolves r1, neither r2 nor r3 may be sent.
			ackNext(0);
			await new Promise((r) => setTimeout(r, 20));
			expect(sent.map((entry) => entry.bodies)).toEqual([["r1"]]);
			expect(closeCalls).toContainEqual({ cancel: true });

			await expect(withinDeadline(r1.ack())).rejects.toMatchObject({
				code: "ABORTED",
				status: 499,
				cause: reason,
			});
			await expect(withinDeadline(r2.ack())).rejects.toMatchObject({
				code: "SESSION_CLOSED",
				cause: expect.objectContaining({ code: "ABORTED", cause: reason }),
			});
			expect(await withinDeadline(r3Write)).toMatchObject({
				code: "ABORTED",
				cause: reason,
			});
			await expect(withinDeadline(producer.close())).rejects.toMatchObject({
				code: "ABORTED",
				status: 499,
				cause: reason,
			});
		});

		it("pipeTo source error between writes aborts without appending a capacity-parked batch or masking the source error", async () => {
			const { transport, sent, ackNext } = createControllableTransport();
			const session = await RetryAppendSession.create(
				async () => transport,
				{ maxInflightBatches: 1 },
				{
					maxAttempts: 3,
					requestTimeoutMillis: 10_000,
					minBaseDelayMillis: 1,
					maxBaseDelayMillis: 1,
				},
			);
			const producer = new Producer(
				new BatchTransform({ lingerDurationMillis: 0, maxBatchRecords: 1 }),
				session,
			);

			const sourceError = new Error("upstream failed");
			let step = 0;
			const source = new ReadableStream<AppendRecordType>({
				async pull(controller) {
					step += 1;
					if (step === 1) {
						controller.enqueue(AppendRecord.string({ body: "r1" }));
						return;
					}
					if (step === 2) {
						await waitFor(() => sent.length === 1);
						controller.enqueue(AppendRecord.string({ body: "r2" }));
						return;
					}
					// Wait until r2 is parked in capacityWaiters before failing upstream.
					await waitFor(() => (session as any).capacityWaiters.length === 1);
					controller.error(sourceError);
				},
			});

			const piped = source.pipeTo(producer.writable);
			await expect(withinDeadline(piped)).rejects.toBe(sourceError);

			ackNext(0);
			await new Promise((r) => setTimeout(r, 20));
			expect(sent.map((entry) => entry.bodies)).toEqual([["r1"]]);
			await expect(withinDeadline(producer.close())).rejects.toMatchObject({
				code: "ABORTED",
				cause: sourceError,
			});
		});

		it("flush failure rejects a capacity-parked batch without appending it while draining already-accepted batches", async () => {
			const { transport, sent, ackNext } = createControllableTransport();
			const session = await RetryAppendSession.create(
				async () => transport,
				{ maxInflightBatches: 1 },
				{ maxAttempts: 1, requestTimeoutMillis: 10_000 },
			);
			const batchTransform = new BatchTransform({
				lingerDurationMillis: 60_000,
				maxBatchRecords: 10,
				maxBatchBytes: 60,
			});
			const producer = new Producer(batchTransform, session);

			// Each 30-byte string has 38 metered bytes: two exceed maxBatchBytes (60),
			// flushing the prior record while keeping the current one in currentBatch.
			const r1 = await producer.submit(
				AppendRecord.string({ body: "a".repeat(30) }),
			);
			const r2 = await producer.submit(
				AppendRecord.string({ body: "b".repeat(30) }),
			);
			await waitFor(() => sent.length === 1);
			// r3 flushes r2 into the pump (parked in capacityWaiters) and stays in
			// currentBatch.
			const r3 = await producer.submit(
				AppendRecord.string({ body: "c".repeat(30) }),
			);
			await waitFor(() => (session as any).capacityWaiters.length === 1);

			const flushError = new S2Error({
				message: "batch flush failed",
				status: 500,
				origin: "sdk",
			});
			vi.spyOn(batchTransform, "flush").mockImplementationOnce(() => {
				throw flushError;
			});

			// flush() fails: r2 and r3 must reject as never sent immediately, and r2
			// must never be sent once r1 acks.
			const flushPromise = producer.flush();
			await Promise.all([
				expect(withinDeadline(r2.ack())).rejects.toMatchObject({
					code: "SESSION_CLOSED",
				}),
				expect(withinDeadline(r3.ack())).rejects.toMatchObject({
					code: "SESSION_CLOSED",
				}),
			]);

			// Already-accepted r1 still drains cleanly.
			ackNext(0);
			await expect(withinDeadline(r1.ack())).resolves.toMatchObject({
				index: 0,
			});
			await expect(withinDeadline(flushPromise)).rejects.toBe(flushError);
			await expect(withinDeadline(producer.close())).rejects.toBe(flushError);
			expect(sent.map((entry) => entry.bodies)).toEqual([["a".repeat(30)]]);
		});

		it("writer.abort() after a local failure cancels draining batches with the abort reason", async () => {
			const { transport, sent } = createControllableTransport();
			const session = await RetryAppendSession.create(
				async () => transport,
				{ maxInflightBatches: 1 },
				{ maxAttempts: 3, requestTimeoutMillis: 10_000 },
			);
			const batchTransform = new BatchTransform({
				lingerDurationMillis: 60_000,
				maxBatchRecords: 1,
			});
			const producer = new Producer(batchTransform, session);

			const r1 = await producer.submit(AppendRecord.string({ body: "r1" }));
			await waitFor(() => sent.length === 1);

			const flushError = new S2Error({
				message: "batch flush failed",
				status: 500,
				origin: "sdk",
			});
			vi.spyOn(batchTransform, "flush").mockImplementationOnce(() => {
				throw flushError;
			});
			const flushPromise = producer.flush();
			await waitFor(() => (session as any).closing === true);

			// Escalate the stalled drain with writer.abort(): r1 must reject with the
			// caller's abort reason, while flush()/close() still report flushError.
			const abortReason = new Error("stop draining");
			const writer = producer.writable.getWriter();
			await withinDeadline(writer.abort(abortReason));

			await expect(withinDeadline(r1.ack())).rejects.toMatchObject({
				code: "ABORTED",
				cause: abortReason,
			});
			await expect(withinDeadline(flushPromise)).rejects.toBe(flushError);
			await expect(withinDeadline(producer.close())).rejects.toBe(flushError);
		});

		it("writer.abort() falls back to closing a custom AppendSession without a writable abort handler", async () => {
			const parkedSubmit = deferred<BatchSubmitTicket>();
			const customSession: AppendSession = {
				readable: new ReadableStream<AppendAck>(),
				writable: new WritableStream<AppendInput>(),
				submit: () => parkedSubmit.promise,
				close: async () => {
					parkedSubmit.reject(
						new S2Error({
							message: "AppendSession is closed",
							code: "SESSION_CLOSED",
						}),
					);
				},
				acks: () => new ReadableStream<AppendAck>() as AcksStream,
				lastAckedPosition: () => undefined,
				failureCause: () => undefined,
				[Symbol.asyncDispose]: async () => {},
			};
			const producer = new Producer(
				new BatchTransform({ lingerDurationMillis: 0, maxBatchRecords: 1 }),
				customSession,
			);

			const r1 = await producer.submit(AppendRecord.string({ body: "r1" }));
			await waitFor(() => (producer as any).inflightRecords.length === 0);

			const writer = producer.writable.getWriter();
			await withinDeadline(writer.abort("stop"));
			await expect(withinDeadline(r1.ack())).rejects.toMatchObject({
				code: "SESSION_CLOSED",
			});
			await expect(withinDeadline(producer.close())).rejects.toMatchObject({
				code: "ABORTED",
				cause: "stop",
			});
		});
	});
});
