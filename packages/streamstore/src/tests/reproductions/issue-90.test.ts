import { describe, expect, it } from "vitest";
import { BatchTransform } from "../../batch-transform.js";
import { AppendRecord } from "../../index.js";
import {
	type AcksStream,
	type AppendSession,
	BatchSubmitTicket,
} from "../../lib/stream/types.js";
import { Producer } from "../../producer.js";
import { type AppendAck, type AppendInput } from "../../types.js";

class MockAppendSession implements AppendSession {
	readonly readable = new ReadableStream<AppendAck>();
	readonly writable = new WritableStream<AppendInput>();
	private readonly acksStream: AcksStream =
		new ReadableStream<AppendAck>() as AcksStream;
	private seq = 0;
	private closed = false;

	async submit(input: AppendInput): Promise<BatchSubmitTicket> {
		if (this.closed) throw new Error("session closed");
		const batch = Array.isArray(input.records)
			? input.records
			: [input.records];
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
}

describe("Issue #90: Producer.close() idempotency", () => {
	it("concurrent close() calls should not throw TypeError", async () => {
		const session = new MockAppendSession();
		const producer = new Producer(
			new BatchTransform({ lingerDurationMillis: 0, maxBatchRecords: 5 }),
			session,
		);

		await producer.submit(AppendRecord.string({ body: "hello" }));

		await expect(
			Promise.all([producer.close(), producer.close()]),
		).resolves.toBeDefined();
	});

	it("explicit close() after writable stream close should not throw", async () => {
		const session = new MockAppendSession();
		const producer = new Producer(
			new BatchTransform({ lingerDurationMillis: 0, maxBatchRecords: 5 }),
			session,
		);

		const writer = producer.writable.getWriter();
		await writer.write(AppendRecord.string({ body: "hello" }));
		await writer.close();

		await expect(producer.close()).resolves.toBeUndefined();
	});
});
