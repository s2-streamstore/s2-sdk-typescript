import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendAck } from "../generated/index.js";
import type { AppendRecord } from "../stream.js";
import { S2Stream } from "../stream.js";

// Minimal Client shape to satisfy S2Stream constructor; we won't use it directly
const fakeClient: any = {};

const makeStream = () => new S2Stream("test-stream", fakeClient);

const makeAck = (n: number): AppendAck => ({
	start: { seq_num: n - 1, timestamp: 0 },
	end: { seq_num: n, timestamp: 0 },
	tail: { seq_num: n, timestamp: 0 },
});

describe("AppendSession", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("serializes submit calls and emits acks in order", async () => {
		const stream = makeStream();
		const appendSpy = vi.spyOn(stream, "append");

		// ensure only one in flight at a time by controlling resolution of spy
		let firstResolved = false;
		appendSpy.mockImplementationOnce(async (..._args: any[]) => {
			await vi.advanceTimersByTimeAsync(10);
			firstResolved = true;
			return makeAck(1);
		});
		appendSpy.mockImplementationOnce(async (..._args: any[]) => {
			expect(firstResolved).toBe(true);
			await vi.advanceTimersByTimeAsync(5);
			return makeAck(2);
		});
		// default fallback
		appendSpy.mockResolvedValue(makeAck(999));

		const session = await stream.appendSession("string");

		const p1 = session.submit([{ format: "string", body: "a" }]);
		const p2 = session.submit([{ format: "string", body: "b" }]);

		const ack1 = await p1;
		const ack2 = await p2;

		expect(appendSpy).toHaveBeenCalledTimes(2);
		expect(ack1.end.seq_num).toBe(1);
		expect(ack2.end.seq_num).toBe(2);
	});

	it("acks() stream receives emitted acks and closes on session.close()", async () => {
		const stream = makeStream();
		const appendSpy = vi
			.spyOn(stream, "append")
			.mockResolvedValueOnce(makeAck(1))
			.mockResolvedValueOnce(makeAck(2));

		const session = await stream.appendSession("string");
		const acks = session.acks();

		const received: AppendAck[] = [];
		const consumer = (async () => {
			for await (const ack of acks) {
				received.push(ack);
			}
		})();

		await session.submit([{ format: "string", body: "a" }]);
		await session.submit([{ format: "string", body: "b" }]);

		await session.close();
		await consumer;

		expect(appendSpy).toHaveBeenCalledTimes(2);
		expect(received.map((a) => a.end.seq_num)).toEqual([1, 2]);
	});

	it("close() waits for drain before resolving", async () => {
		const stream = makeStream();
		const appendSpy = vi.spyOn(stream, "append");

		appendSpy.mockResolvedValueOnce(makeAck(1));
		appendSpy.mockResolvedValueOnce(makeAck(2));

		const session = await stream.appendSession("string");

		const p1 = session.submit([{ format: "string", body: "x" }]);
		const p2 = session.submit([{ format: "string", body: "y" }]);

		await Promise.all([p1, p2]);
		await session.close();

		await expect(p1).resolves.toBeTruthy();
		await expect(p2).resolves.toBeTruthy();
		expect(appendSpy).toHaveBeenCalledTimes(2);
	});

	it("submit after close() rejects", async () => {
		const stream = makeStream();
		vi.spyOn(stream, "append").mockResolvedValue(makeAck(1));
		const session = await stream.appendSession("string");

		await session.close();

		await expect(
			session.submit([{ format: "string", body: "x" }]),
		).rejects.toMatchObject({
			message: expect.stringContaining("AppendSession is closed"),
		});
	});

	it("error during processing rejects current and queued, clears queue", async () => {
		const stream = makeStream();
		const appendSpy = vi.spyOn(stream, "append");

		appendSpy.mockRejectedValueOnce(new Error("boom"));

		const session = await stream.appendSession("string");

		const p1 = session.submit([{ format: "string", body: "a" }]);
		const p2 = session.submit([{ format: "string", body: "b" }]);
		// suppress unhandled rejection warnings
		p1.catch(() => {});
		p2.catch(() => {});

		await expect(p1).rejects.toBeTruthy();
		await expect(p2).rejects.toBeTruthy();

		// After error, queue should be empty; new submit should restart processing
		appendSpy.mockResolvedValueOnce(makeAck(3));
		const p3 = session.submit([{ format: "string", body: "c" }]);
		await expect(p3).resolves.toBeTruthy();
		expect(appendSpy).toHaveBeenCalledTimes(2); // 1 throw + 1 success
	});

	it("updates lastSeenPosition after successful append", async () => {
		const stream = makeStream();
		vi.spyOn(stream, "append").mockResolvedValue(makeAck(42));
		const session = await stream.appendSession("string");
		await session.submit([{ format: "string", body: "z" }]);
		expect(session.lastSeenPosition?.end.seq_num).toBe(42);
	});

	it("applies backpressure when queue exceeds maxQueuedBytes", async () => {
		const stream = makeStream();
		const appendSpy = vi.spyOn(stream, "append");

		// Create a session with very small max queued bytes (100 bytes)
		const session = await stream.appendSession("string", {
			maxQueuedBytes: 100,
		});

		// Control when appends resolve
		let resolveFirst: any;
		const firstPromise = new Promise<AppendAck>((resolve) => {
			resolveFirst = () => resolve(makeAck(1));
		});

		appendSpy.mockReturnValueOnce(firstPromise);
		appendSpy.mockResolvedValueOnce(makeAck(2));
		appendSpy.mockResolvedValueOnce(makeAck(3));

		// Use the WritableStream interface (session IS a WritableStream)
		const writer = session.getWriter();

		// Submit first batch (50 bytes) - should succeed immediately
		const largeBody = "x".repeat(42); // ~50 bytes with overhead
		const p1 = writer.write({
			records: [{ format: "string", body: largeBody }],
		});

		// Submit second batch (50 bytes) - should also queue
		const p2 = writer.write({
			records: [{ format: "string", body: largeBody }],
		});

		// Submit third batch (50 bytes) - should block due to backpressure
		let thirdWriteStarted = false;
		const p3 = (async () => {
			await writer.write({ records: [{ format: "string", body: largeBody }] });
			thirdWriteStarted = true;
		})();

		// Give time for any immediate processing
		await Promise.resolve();
		await Promise.resolve();

		// Third write should be blocked waiting for capacity
		expect(thirdWriteStarted).toBe(false);

		// Resolve first append to free capacity
		resolveFirst();
		await p1;

		// Now third should be able to proceed
		await p2;
		await p3;

		expect(thirdWriteStarted).toBe(true);
		expect(appendSpy).toHaveBeenCalledTimes(3);

		await writer.close();
	});
});
