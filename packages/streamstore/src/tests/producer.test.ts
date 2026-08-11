import { describe, expect, it } from "vitest";
import { BatchTransform } from "../batch-transform.js";
import { S2Error } from "../error.js";
import { AppendRecord } from "../index.js";
import {
	type AcksStream,
	type AppendRecord as AppendRecordType,
	type AppendSession,
	BatchSubmitTicket,
} from "../lib/stream/types.js";
import { Producer } from "../producer.js";
import { type AppendAck, type AppendInput } from "../types.js";

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

type ControlledAppendCall = {
	input: AppendInput;
	ack: Deferred<AppendAck>;
};

class ControlledAppendSession implements AppendSession {
	readonly readable = new ReadableStream<AppendAck>();
	readonly writable = new WritableStream<AppendInput>();
	private readonly acksStream = new ReadableStream<AppendAck>() as AcksStream;
	private readonly calls: ControlledAppendCall[] = [];
	private readonly callWaiters: Array<(call: ControlledAppendCall) => void> =
		[];
	private readonly submitFailure?: { call: number; error: S2Error };

	submitCount = 0;

	constructor(submitFailure?: { call: number; error: S2Error }) {
		this.submitFailure = submitFailure;
	}

	async submit(input: AppendInput): Promise<BatchSubmitTicket> {
		const call = { input, ack: deferred<AppendAck>() };
		this.submitCount += 1;
		const waiter = this.callWaiters.shift();
		if (waiter) {
			waiter(call);
		} else {
			this.calls.push(call);
		}

		if (this.submitFailure?.call === this.submitCount) {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			throw this.submitFailure.error;
		}

		return new BatchSubmitTicket(call.ack.promise, 0, input.records.length);
	}

	nextCall(): Promise<ControlledAppendCall> {
		const call = this.calls.shift();
		if (call) {
			return Promise.resolve(call);
		}
		return new Promise((resolve) => this.callWaiters.push(resolve));
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

function appendAck(start: number, records: number): AppendAck {
	return {
		start: { seqNum: start, timestamp: new Date(0) },
		end: { seqNum: start + records, timestamp: new Date(0) },
		tail: { seqNum: start + records, timestamp: new Date(0) },
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

	it("flush emits a partial batch and waits for every covered ack", async () => {
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
		const fullBatch = await session.nextCall();
		const flush = producer.flush();
		const partialBatch = await session.nextCall();

		expect(fullBatch.input.records).toHaveLength(2);
		expect(partialBatch.input.records).toHaveLength(1);

		const fullBatchAck = appendAck(41, 2);
		fullBatch.ack.resolve(fullBatchAck);
		await Promise.all([tickets[0].ack(), tickets[1].ack()]);
		await expectPending(flush);

		const partialBatchAck = appendAck(43, 1);
		partialBatch.ack.resolve(partialBatchAck);
		await flush;

		const recordAcks = await Promise.all(tickets.map((ticket) => ticket.ack()));
		expect(recordAcks.map((ack) => ack.seqNum())).toEqual([41, 42, 43]);
		expect(recordAcks[0]?.batchAppendAck()).toBe(fullBatchAck);
		expect(recordAcks[1]?.batchAppendAck()).toBe(fullBatchAck);
		expect(recordAcks[2]?.batchAppendAck()).toBe(partialBatchAck);

		await producer.close();
	});

	it("flush is an empty-safe, reusable prefix boundary", async () => {
		const session = new ControlledAppendSession();
		const producer = new Producer(
			new BatchTransform({
				lingerDurationMillis: 60_000,
				maxBatchRecords: 100,
			}),
			session,
		);

		await producer.flush();
		expect(session.submitCount).toBe(0);

		const firstTicket = await producer.submit(
			AppendRecord.string({ body: "before" }),
		);
		const firstFlush = producer.flush();
		const firstCall = await session.nextCall();
		const laterTicketPromise = producer.submit(
			AppendRecord.string({ body: "after" }),
		);

		firstCall.ack.resolve(appendAck(0, 1));
		await firstFlush;
		const laterTicket = await laterTicketPromise;
		expect((await firstTicket.ack()).seqNum()).toBe(0);
		expect(session.submitCount).toBe(1);

		const secondFlush = producer.flush();
		const secondCall = await session.nextCall();
		secondCall.ack.resolve(appendAck(1, 1));
		await secondFlush;
		expect((await laterTicket.ack()).seqNum()).toBe(1);

		await producer.close();
	});

	it.each(["submit", "ack"] as const)(
		"flush propagates a covered %s failure",
		async (failurePhase) => {
			const error = new S2Error({
				message: `${failurePhase} failed`,
				status: 412,
				origin: "server",
			});
			const session = new ControlledAppendSession(
				failurePhase === "submit" ? { call: 2, error } : undefined,
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
			await session.nextCall();
			const failingCall = await session.nextCall();
			const flush = producer.flush();
			if (failurePhase === "ack") {
				failingCall.ack.reject(error);
			}

			await Promise.all([
				expect(firstTicket.ack()).rejects.toBe(error),
				expect(secondTicket.ack()).rejects.toBe(error),
				expect(flush).rejects.toBe(error),
			]);
			await expect(producer.flush()).rejects.toBe(error);
			await expect(producer.close()).rejects.toBe(error);
		},
	);
});
