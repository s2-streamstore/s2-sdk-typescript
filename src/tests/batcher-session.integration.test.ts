import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchTransform } from "../batch-transform.js";
import type { AppendAck } from "../generated/index.js";
import { S2Stream } from "../stream.js";

const fakeClient: any = {};
const makeStream = () => new S2Stream("test-stream", fakeClient);
const makeAck = (n: number): AppendAck => ({
	start: { seq_num: n - 1, timestamp: 0 },
	end: { seq_num: n, timestamp: 0 },
	tail: { seq_num: n, timestamp: 0 },
});

describe("BatchTransform + AppendSession integration", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("linger-driven batching yields single session submission", async () => {
		const stream = makeStream();
		const session = await stream.appendSession();
		const appendSpy = vi.spyOn(stream, "append").mockResolvedValue(makeAck(1));

		const batcher = new BatchTransform({
			lingerDuration: 10,
			maxBatchRecords: 100,
		});

		// Pipe batcher output to session
		const pipePromise = batcher.readable.pipeTo(session);

		const writer = batcher.writable.getWriter();
		await writer.write({ body: "a" });
		await writer.write({ body: "b" });
		await writer.close();

		// Wait for linger to flush and pipe to complete
		await vi.advanceTimersByTimeAsync(12);
		await pipePromise;

		expect(appendSpy).toHaveBeenCalledTimes(1);
		expect(appendSpy.mock.calls?.[0]?.[0]).toHaveLength(2);
	});

	it("batch overflow increments match_seq_num across multiple flushes", async () => {
		const stream = makeStream();
		const session = await stream.appendSession();
		const appendSpy = vi.spyOn(stream, "append");
		appendSpy.mockResolvedValueOnce(makeAck(1));
		appendSpy.mockResolvedValueOnce(makeAck(2));

		const batcher = new BatchTransform({
			lingerDuration: 0,
			maxBatchRecords: 2,
			match_seq_num: 5,
		});

		// Pipe batcher output to session
		const pipePromise = batcher.readable.pipeTo(session);

		const writer = batcher.writable.getWriter();
		await writer.write({ body: "1" });
		await writer.write({ body: "2" });
		await writer.write({ body: "3" });
		await writer.close();

		await pipePromise;

		expect(appendSpy).toHaveBeenCalledTimes(2);
		expect(appendSpy.mock.calls?.[0]?.[1]).toMatchObject({ match_seq_num: 5 });
		expect(appendSpy.mock.calls?.[1]?.[1]).toMatchObject({ match_seq_num: 7 });
	});

	it("batches are acknowledged via session.acks()", async () => {
		const stream = makeStream();
		const session = await stream.appendSession();
		vi.spyOn(stream, "append").mockResolvedValue(makeAck(123));

		const batcher = new BatchTransform({
			lingerDuration: 0,
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
		const pipePromise = batcher.readable.pipeTo(session);

		const writer = batcher.writable.getWriter();
		await writer.write({ body: "x" });
		await writer.close();

		// Wait for pipe to complete (which closes the session)
		await pipePromise;
		// Wait for acks to finish
		await acksPromise;

		expect(acks).toHaveLength(1);
		expect(acks[0]?.end.seq_num).toBe(123);
	});
});
