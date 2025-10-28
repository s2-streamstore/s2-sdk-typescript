import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendAck } from "../generated/index.js";
import * as Redacted from "../lib/redacted.js";
import type { AppendRecord } from "../lib/stream/types.js";
import { S2Stream } from "../stream.js";

const fakeClient: any = {};
const fakeTransportConfig = {
	baseUrl: "https://test.s2.dev/v1",
	accessToken: Redacted.make("test-token"),
};
const makeStream = () =>
	new S2Stream("test-stream", fakeClient, fakeTransportConfig);
const makeAck = (n: number): AppendAck => ({
	start: { seq_num: n - 1, timestamp: 0 },
	end: { seq_num: n, timestamp: 0 },
	tail: { seq_num: n, timestamp: 0 },
});

describe("Batcher", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("batches submits within linger window into single session.submit", async () => {
		const stream = makeStream();
		const session = await stream.appendSession();
		const submitSpy = vi.spyOn(session, "submit").mockResolvedValue(makeAck(1));

		const batcher = session.makeBatcher({
			lingerDuration: 20,
			maxBatchSize: 10,
		});

		const p1 = batcher.submit({ body: "a" });
		const p2 = batcher.submit({ body: "b" });

		// nothing flushed yet
		expect(submitSpy).toHaveBeenCalledTimes(0);

		await vi.advanceTimersByTimeAsync(20);

		// now one flush
		await Promise.all([p1, p2]);
		expect(submitSpy).toHaveBeenCalledTimes(1);
		const firstCall = submitSpy.mock.calls[0] as unknown[];
		const recordsArg = firstCall?.[0] as AppendRecord[];
		expect(recordsArg).toHaveLength(2);
	});

	it("manual flush cancels timer and sends immediately", async () => {
		const stream = makeStream();
		const session = await stream.appendSession();
		const submitSpy = vi
			.spyOn(session, "submit")
			.mockResolvedValue(makeAck(99));

		const batcher = session.makeBatcher({
			lingerDuration: 1000,
			maxBatchSize: 10,
		});
		const p = batcher.submit({ body: "x" });
		batcher.flush();

		await p;
		expect(submitSpy).toHaveBeenCalledTimes(1);
	});

	it("close() flushes remaining and prevents further submit", async () => {
		const stream = makeStream();
		const session = await stream.appendSession();
		vi.spyOn(session, "submit").mockResolvedValue(makeAck(1));
		const batcher = session.makeBatcher({
			lingerDuration: 1000,
			maxBatchSize: 10,
		});

		const p = batcher.submit({ body: "x" });
		await batcher.close();
		await p;

		await expect(batcher.submit({ body: "y" })).rejects.toMatchObject({
			message: expect.stringContaining("Batcher is closed"),
		});
	});

	it("abort rejects pending with S2Error, clears batch", async () => {
		const stream = makeStream();
		const session = await stream.appendSession();
		vi.spyOn(session, "submit").mockResolvedValue(makeAck(1));
		const batcher = session.makeBatcher({
			lingerDuration: 1000,
			maxBatchSize: 10,
		});

		const p = batcher.submit({ body: "x" });
		const writer = batcher.getWriter?.() ?? batcher;
		await writer.abort?.("stop");

		await expect(p).rejects.toMatchObject({
			message: expect.stringContaining("Batcher was aborted: stop"),
		});
	});

	it("propagates fencing_token and auto-increments match_seq_num across batches", async () => {
		const stream = makeStream();
		const session = await stream.appendSession();
		const submitSpy = vi.spyOn(session, "submit");
		submitSpy.mockResolvedValueOnce(makeAck(1));
		submitSpy.mockResolvedValueOnce(makeAck(2));

		const batcher = session.makeBatcher({
			lingerDuration: 0,
			maxBatchSize: 2,
			fencing_token: "ft",
			match_seq_num: 10,
		});

		// First batch: two records
		const p1 = batcher.submit([{ body: "a" }, { body: "b" }]);
		batcher.flush();
		await p1;
		// Second batch: one record
		const p2 = batcher.submit([{ body: "c" }]);
		batcher.flush();
		await p2;

		expect(submitSpy).toHaveBeenCalledTimes(2);
		const c0 = submitSpy.mock.calls[0] as unknown[];
		const c1 = submitSpy.mock.calls[1] as unknown[];
		expect(c0?.[1]).toMatchObject({
			fencing_token: "ft",
			match_seq_num: 10,
		});
		expect(c1?.[1]).toMatchObject({
			fencing_token: "ft",
			match_seq_num: 12,
		});
	});

	it("array submit is atomic: if it won't fit, flush current then enqueue whole array", async () => {
		const stream = makeStream();
		const session = await stream.appendSession();
		const submitSpy = vi.spyOn(session, "submit").mockResolvedValue(makeAck(1));

		const batcher = session.makeBatcher({
			lingerDuration: 0,
			maxBatchSize: 3,
		});

		// Fill current batch with two singles (no auto flush because linger=0)
		batcher.submit({ body: "a" });
		batcher.submit({ body: "b" });

		// Now submit an array of 2 (atomic). Since 2+2>3, it flushes current 2,
		// then enqueues both array records into the next batch
		const p = batcher.submit([{ body: "c" }, { body: "d" }]);

		// First flush happened immediately for the two singles
		expect(submitSpy).toHaveBeenCalledTimes(1);
		expect(
			(submitSpy.mock.calls[0] as unknown[])?.[0] as AppendRecord[],
		).toHaveLength(2);

		// Explicitly flush the array batch because linger=0
		batcher.flush();
		await p;
		expect(submitSpy).toHaveBeenCalledTimes(2);
		expect(
			(submitSpy.mock.calls[1] as unknown[])?.[0] as AppendRecord[],
		).toHaveLength(2);
	});

	it("array submit never splits across batches and resolves with single batch ack", async () => {
		const stream = makeStream();
		const session = await stream.appendSession();
		const submitSpy = vi.spyOn(session, "submit");

		// Two submits will occur: first flush of existing single; second flush of the array
		submitSpy.mockResolvedValueOnce(makeAck(1));
		submitSpy.mockResolvedValueOnce(makeAck(2));
		const batcher = session.makeBatcher({ lingerDuration: 0, maxBatchSize: 2 });

		// Fill current batch to 1
		batcher.submit({ body: "x" });
		// Submit 2-record array: should flush current (1), then submit both together (2)
		const promise = batcher.submit([{ body: "a" }, { body: "b" }]);

		expect(submitSpy).toHaveBeenCalledTimes(1);
		expect(
			(submitSpy.mock.calls[0] as unknown[])?.[0] as AppendRecord[],
		).toHaveLength(1);

		batcher.flush();
		await promise;
		expect(submitSpy).toHaveBeenCalledTimes(2);
		expect(
			(submitSpy.mock.calls[1] as unknown[])?.[0] as AppendRecord[],
		).toHaveLength(2);
	});

	it("array submit rejects if its single batch fails", async () => {
		const stream = makeStream();
		const session = await stream.appendSession();
		const submitSpy = vi.spyOn(session, "submit");

		submitSpy.mockRejectedValueOnce(new Error("batch failed"));

		const batcher = session.makeBatcher({ lingerDuration: 0, maxBatchSize: 2 });
		const promise = batcher.submit([{ body: "a" }, { body: "b" }]);
		// suppress unhandled rejection warning
		promise.catch(() => {});

		batcher.flush();
		await expect(promise).rejects.toThrow("batch failed");
	});
});
