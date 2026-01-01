import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchTransform } from "../batch-transform.js";
import { AppendInput, AppendRecord } from "../index.js";
import * as Redacted from "../lib/redacted.js";
import * as SharedTransport from "../lib/stream/transport/fetch/shared.js";
import { S2Stream } from "../stream.js";
import type { AppendAck } from "../types.js";

const fakeClient: any = {};
const makeStream = () =>
	new S2Stream("test-stream", fakeClient, {
		baseUrl: "https://test.b.aws.s2.dev",
		accessToken: Redacted.make("test-access-token"),
		forceTransport: "fetch",
	});
// streamAppend returns GENERATED AppendAck (seq_num, number), not SDK types
const makeAck = (n: number): any => ({
	start: { seqNum: n - 1, timestamp: 0 },
	end: { seqNum: n, timestamp: 0 },
	tail: { seqNum: n, timestamp: 0 },
});

describe("BatchTransform + AppendSession integration", () => {
	let streamAppendSpy: any;

	beforeEach(() => {
		vi.useFakeTimers();
		// Mock streamAppend which is what appendSession() actually uses
		streamAppendSpy = vi.spyOn(SharedTransport, "streamAppend");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("linger-driven batching yields single session submission", async () => {
		const stream = makeStream();
		const session = await stream.appendSession();
		// Mock returns ack based on number of records submitted
		let cumulativeSeq = 0;
		streamAppendSpy.mockImplementation((_0: any, _1: any, input: any) => {
			const start = cumulativeSeq;
			cumulativeSeq += input.records.length;
			// streamAppend returns GENERATED types (seq_num, number)
			return Promise.resolve({
				start: { seqNum: start, timestamp: 0 },
				end: { seqNum: cumulativeSeq, timestamp: 0 },
				tail: { seqNum: cumulativeSeq, timestamp: 0 },
			});
		});

		const batcher = new BatchTransform({
			lingerDurationMillis: 10,
			maxBatchRecords: 100,
		});

		// Pipe batcher output to session
		const pipePromise = batcher.readable.pipeTo(session.writable);

		const writer = batcher.writable.getWriter();
		await writer.write(AppendRecord.string({ body: "a" }));
		await writer.write(AppendRecord.string({ body: "b" }));
		await writer.close();

		// Wait for linger to flush and pipe to complete
		await vi.advanceTimersByTimeAsync(12);
		await pipePromise;

		expect(streamAppendSpy).toHaveBeenCalledTimes(1);
		expect(streamAppendSpy.mock.calls?.[0]?.[2]?.records).toHaveLength(2);
	});

	it("batch overflow increments matchSeqNum across multiple flushes", async () => {
		const stream = makeStream();
		const session = await stream.appendSession();
		// Mock returns ack based on number of records submitted
		let cumulativeSeq = 0;
		streamAppendSpy.mockImplementation((_0: any, _1: any, input: any) => {
			const start = cumulativeSeq;
			cumulativeSeq += input.records.length;
			// streamAppend returns GENERATED types (seq_num, number)
			return Promise.resolve({
				start: { seqNum: start, timestamp: 0 },
				end: { seqNum: cumulativeSeq, timestamp: 0 },
				tail: { seqNum: cumulativeSeq, timestamp: 0 },
			});
		});

		const batcher = new BatchTransform({
			lingerDurationMillis: 0,
			maxBatchRecords: 2,
			matchSeqNum: 5,
		});

		// Pipe batcher output to session
		const pipePromise = batcher.readable.pipeTo(session.writable);

		const writer = batcher.writable.getWriter();
		await writer.write(AppendRecord.string({ body: "1" }));
		await writer.write(AppendRecord.string({ body: "2" }));
		await writer.write(AppendRecord.string({ body: "3" }));
		await writer.close();

		// Advance timers to allow linger flushes to complete
		await vi.advanceTimersByTimeAsync(10);
		await pipePromise;

		expect(streamAppendSpy).toHaveBeenCalledTimes(2);
		expect(streamAppendSpy.mock.calls?.[0]?.[2]).toMatchObject({
			matchSeqNum: 5,
		});
		expect(streamAppendSpy.mock.calls?.[1]?.[2]).toMatchObject({
			matchSeqNum: 7,
		});
	});

	it("batches are acknowledged via session.acks()", async () => {
		const stream = makeStream();
		const session = await stream.appendSession();
		// Mock returns ack based on number of records submitted
		let cumulativeSeq = 0;
		streamAppendSpy.mockImplementation((_0: any, _1: any, input: any) => {
			const start = cumulativeSeq;
			cumulativeSeq += input.records.length;
			// streamAppend returns GENERATED types (seq_num, number)
			return Promise.resolve({
				start: { seqNum: start, timestamp: 0 },
				end: { seqNum: cumulativeSeq, timestamp: 0 },
				tail: { seqNum: cumulativeSeq, timestamp: 0 },
			});
		});

		const batcher = new BatchTransform({
			lingerDurationMillis: 0,
			maxBatchRecords: 10,
		});

		// Collect acks
		const acks: AppendAck[] = [];
		const acksPromise = (async () => {
			for await (const ack of session.acks()) {
				acks.push(ack);
			}
		})();

		// Pipe batcher output to session (this will close the session when done)
		const pipePromise = batcher.readable.pipeTo(session.writable);

		const writer = batcher.writable.getWriter();
		await writer.write(AppendRecord.string({ body: "x" }));
		await writer.close();

		// Wait for pipe to complete (which closes the session)
		await pipePromise;
		// Wait for acks to finish
		await acksPromise;

		expect(acks).toHaveLength(1);
		expect(acks[0]?.end.seqNum).toBe(1); // 1 record written (SDK types use bigint)
	});
});
