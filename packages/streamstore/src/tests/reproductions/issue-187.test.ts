import { describe, expect, it } from "vitest";
import { BatchTransform } from "../../batch-transform.js";
import { S2Error } from "../../error.js";
import { AppendRecord } from "../../index.js";
import {
	type AcksStream,
	type AppendSession,
	BatchSubmitTicket,
} from "../../lib/stream/types.js";
import { Producer } from "../../producer.js";
import type { AppendAck, AppendInput } from "../../types.js";

/**
 * Mock AppendSession that immediately acknowledges every batch.
 */
class MockAppendSession implements AppendSession {
	readonly readable = new ReadableStream<AppendAck>();
	readonly writable = new WritableStream<AppendInput>();
	private readonly acksStream: AcksStream =
		new ReadableStream<AppendAck>() as AcksStream;
	private seq = 0;

	async submit(input: AppendInput): Promise<BatchSubmitTicket> {
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

	async close(): Promise<void> {}

	acks(): AcksStream {
		return this.acksStream;
	}

	lastAckedPosition(): AppendAck | undefined {
		return undefined;
	}

	failureCause(): undefined {
		return undefined;
	}

	async [Symbol.asyncDispose](): Promise<void> {}
}

describe("issue-187: Oversized record with pending linger timer crashes process", () => {
	// Reproduces the scenario from the bug report:
	//
	// 1. Records are written to a Producer backed by a BatchTransform.
	// 2. A good record is accepted and starts the linger timer.
	// 3. An oversized record (> maxBatchBytes) is written, causing
	//    handleRecord() to throw inside the transform callback.
	// 4. The TransformStream is now errored, but the linger timer is
	//    still pending.
	// 5. When the linger timer fires, flush() calls
	//    controller.enqueue() on the errored stream, which throws.
	//
	// In version 0.22.5, this throw from the setTimeout callback
	// escaped as an uncaughtException, crashing the process. The
	// fix (issue-136) added a try-catch around flush() in the timer
	// callback, and a cancel hook to clear the timer on stream
	// cancellation. Additionally (issue-187), we now cancel the
	// linger timer before throwing from handleRecord, so the timer
	// never fires at all for this case.

	it("oversized record after good record: pending ack is rejected, no crash", async () => {
		const session = new MockAppendSession();
		const producer = new Producer(
			new BatchTransform({
				lingerDurationMillis: 50,
				maxBatchBytes: 100, // Small limit for testing
			}),
			session,
		);

		// Submit a good record — this starts the linger timer.
		const ticket = await producer.submit(AppendRecord.string({ body: "good" }));

		// Submit an oversized record — this should throw, not crash.
		const oversized = AppendRecord.string({ body: "x".repeat(200) });
		await expect(producer.submit(oversized)).rejects.toThrow(
			/exceeds maximum batch size/,
		);

		// Wait for the linger timer to fire (would have crashed in 0.22.5).
		await new Promise((resolve) => setTimeout(resolve, 100));

		// The good record's ack must be rejected (not hang forever).
		// The stream errored, so the Producer's pump rejects all inflight acks.
		await expect(ticket.ack()).rejects.toThrow();

		// Cleanup — close will throw because of the pump error, that's expected.
		await producer.close().catch(() => {});
	});

	it("linger timer fires after stream error: no uncaught exception", async () => {
		const batcher = new BatchTransform({
			lingerDurationMillis: 50,
			maxBatchBytes: 100,
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		// Start a read to avoid backpressure deadlock (TransformStream
		// readable has highWaterMark=0, so a pending read is needed to
		// allow the writable to proceed).
		const readPromise = reader.read().catch((e: unknown) => e);

		// Write a good record (starts linger timer).
		await writer.write(AppendRecord.string({ body: "good" }));

		// Write an oversized record — errors the transform stream.
		const writePromise = writer
			.write(AppendRecord.string({ body: "x".repeat(200) }))
			.catch((e: unknown) => e);

		const [writeResult, readResult] = await Promise.all([
			writePromise,
			readPromise,
		]);

		// Both sides of the stream should see the error.
		expect(writeResult).toBeInstanceOf(Error);
		expect(readResult).toBeInstanceOf(Error);

		// Wait for the linger timer to fire.
		// Before the fix, this setTimeout callback would call flush()
		// → controller.enqueue() → uncaughtException.
		await new Promise((resolve) => setTimeout(resolve, 100));

		// If we reach here, no uncaught exception occurred.
		expect(true).toBe(true);
	});

	it("good records submitted before oversized record are properly settled", async () => {
		const session = new MockAppendSession();
		const producer = new Producer(
			new BatchTransform({
				lingerDurationMillis: 50,
				maxBatchBytes: 100,
			}),
			session,
		);

		// Submit several good records — all start accumulating in the batch.
		const tickets = [];
		for (let i = 0; i < 3; i++) {
			tickets.push(
				await producer.submit(AppendRecord.string({ body: `r${i}` })),
			);
		}

		// Submit oversized record — errors the stream.
		await expect(
			producer.submit(AppendRecord.string({ body: "x".repeat(200) })),
		).rejects.toThrow(/exceeds maximum batch size/);

		// Wait for timer and async settlement.
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Every good record's ack must settle (reject, not hang).
		const results = await Promise.allSettled(tickets.map((t) => t.ack()));
		for (const result of results) {
			expect(result.status).toBe("rejected");
		}

		await producer.close().catch(() => {});
	});

	// Issue #181: the bare catch {} in the timer callback silently swallows
	// non-lifecycle errors (like validation S2Errors from AppendInput.create).
	// This test verifies that such errors propagate to the readable side via
	// controller.error() instead of being silently discarded.
	it("validation error from timer flush propagates to readable, not silently lost (issue-181)", async () => {
		// Set matchSeqNum to MAX_SAFE_INTEGER so the SECOND batch overflows.
		const batcher = new BatchTransform({
			lingerDurationMillis: 20,
			matchSeqNum: Number.MAX_SAFE_INTEGER,
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		// First batch: matchSeqNum = MAX_SAFE_INTEGER (valid).
		// Start reading first to avoid backpressure.
		const read1 = reader.read();
		await writer.write(AppendRecord.string({ body: "first" }));

		// Wait for linger timer to flush the first batch.
		await new Promise((resolve) => setTimeout(resolve, 50));

		const result1 = await read1;
		expect(result1.done).toBe(false);
		expect(result1.value!.matchSeqNum).toBe(Number.MAX_SAFE_INTEGER);

		// Second record: nextMatchSeqNum is now MAX_SAFE_INTEGER + 1.
		// The timer flush will call AppendInput.create() with an unsafe
		// matchSeqNum, throwing S2Error. With the fix, this error
		// propagates via controller.error() instead of being swallowed.
		const read2Promise = reader.read().catch((e: unknown) => e);
		await writer.write(AppendRecord.string({ body: "second" }));

		// Wait for linger timer to fire and attempt flush.
		await new Promise((resolve) => setTimeout(resolve, 50));

		const result2 = await read2Promise;
		expect(result2).toBeInstanceOf(S2Error);
		expect((result2 as S2Error).message).toContain("matchSeqNum");
	});
});
