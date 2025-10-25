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

		const session = await stream.appendSession();

		const p1 = session.submit([{ body: "a" }]);
		const p2 = session.submit([{ body: "b" }]);

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

		const session = await stream.appendSession();
		const acks = session.acks();

		const received: AppendAck[] = [];
		const consumer = (async () => {
			for await (const ack of acks) {
				received.push(ack);
			}
		})();

		await session.submit([{ body: "a" }]);
		await session.submit([{ body: "b" }]);

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

		const session = await stream.appendSession();

		const p1 = session.submit([{ body: "x" }]);
		const p2 = session.submit([{ body: "y" }]);

		await Promise.all([p1, p2]);
		await session.close();

		await expect(p1).resolves.toBeTruthy();
		await expect(p2).resolves.toBeTruthy();
		expect(appendSpy).toHaveBeenCalledTimes(2);
	});

	it("submit after close() rejects", async () => {
		const stream = makeStream();
		vi.spyOn(stream, "append").mockResolvedValue(makeAck(1));
		const session = await stream.appendSession();

		await session.close();

		await expect(session.submit([{ body: "x" }])).rejects.toMatchObject({
			message: expect.stringContaining("AppendSession is closed"),
		});
	});

	it("error during processing rejects current and queued, clears queue", async () => {
		const stream = makeStream();
		const appendSpy = vi.spyOn(stream, "append");

		appendSpy.mockRejectedValueOnce(new Error("boom"));

		const session = await stream.appendSession();

		const p1 = session.submit([{ body: "a" }]);
		const p2 = session.submit([{ body: "b" }]);
		// suppress unhandled rejection warnings
		p1.catch(() => {});
		p2.catch(() => {});

		await expect(p1).rejects.toBeTruthy();
		await expect(p2).rejects.toBeTruthy();

		// After error, queue should be empty; new submit should restart processing
		appendSpy.mockResolvedValueOnce(makeAck(3));
		const p3 = session.submit([{ body: "c" }]);
		await expect(p3).resolves.toBeTruthy();
		expect(appendSpy).toHaveBeenCalledTimes(2); // 1 throw + 1 success
	});

	it("updates lastSeenPosition after successful append", async () => {
		const stream = makeStream();
		vi.spyOn(stream, "append").mockResolvedValue(makeAck(42));
		const session = await stream.appendSession();
		await session.submit([{ body: "z" }]);
		expect(session.lastSeenPosition?.end.seq_num).toBe(42);
	});
});
