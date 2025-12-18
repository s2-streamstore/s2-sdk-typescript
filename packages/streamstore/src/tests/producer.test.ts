import { describe, expect, it } from "vitest";
import { BatchTransform } from "../batch-transform.js";
import type { AppendAck } from "../generated/index.js";
import {
	type AcksStream,
	type AppendArgs,
	type AppendRecord as AppendRecordType,
	type AppendSession,
	BatchSubmitTicket,
} from "../lib/stream/types.js";
import { Producer } from "../producer.js";
import { AppendRecord } from "../utils.js";

class MockAppendSession implements AppendSession {
	readonly readable = new ReadableStream<AppendAck>();
	readonly writable = new WritableStream<AppendArgs>();
	private readonly acksStream: AcksStream =
		new ReadableStream<AppendAck>() as AcksStream;

	private readonly received: string[] = [];
	private seq = 0;
	private closed = false;

	async submit(
		records: AppendRecordType | AppendRecordType[],
	): Promise<BatchSubmitTicket> {
		if (this.closed) {
			throw new Error("session closed");
		}

		const batch = Array.isArray(records) ? records : [records];
		for (const record of batch) {
			if (typeof record.body !== "string") {
				throw new Error("expected string body in test harness");
			}
			this.received.push(record.body);
		}

		const ack: AppendAck = {
			start: { seq_num: this.seq, timestamp: 0 },
			end: { seq_num: this.seq + batch.length, timestamp: 0 },
			tail: { seq_num: this.seq + batch.length, timestamp: 0 },
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
	readonly writable = new WritableStream<AppendArgs>();
	private readonly acksStream: AcksStream =
		new ReadableStream<AppendAck>() as AcksStream;

	private readonly received: string[] = [];
	private seq = 0;
	private closed = false;
	private callCount = 0;

	async submit(
		records: AppendRecordType | AppendRecordType[],
	): Promise<BatchSubmitTicket> {
		if (this.closed) {
			throw new Error("session closed");
		}

		const batch = Array.isArray(records) ? records : [records];
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
							start: { seq_num: start, timestamp: 0 },
							end: { seq_num: this.seq, timestamp: 0 },
							tail: { seq_num: this.seq, timestamp: 0 },
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

describe("Producer", () => {
	it("preserves record order when batching", async () => {
		const session = new MockAppendSession();
		const producer = new Producer(
			new BatchTransform({ lingerDurationMillis: 0, maxBatchRecords: 5 }),
			session,
		);

		const total = 100;
		for (let i = 0; i < total; i++) {
			await producer.submit(AppendRecord.make(`rec-${i}`));
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
			submissions.push(producer.submit(AppendRecord.make(`rec-${i}`)));
		}
		await Promise.all(submissions);

		await producer.close();
		await new Promise((resolve) => setTimeout(resolve, 25));

		expect(session.getValues()).toEqual(["rec-0", "rec-1", "rec-2", "rec-3"]);
	});
});
