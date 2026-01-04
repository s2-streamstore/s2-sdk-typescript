import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as API from "../generated/index.js";
import { AppendInput, AppendRecord } from "../index.js";
import * as Redacted from "../lib/redacted.js";
import * as SharedTransport from "../lib/stream/transport/fetch/shared.js";
import { S2Stream } from "../stream.js";
import * as Types from "../types.js";

// Minimal Client shape to satisfy S2Stream constructor; we won't use it directly
const fakeClient: any = {};

const makeStream = (retry?: { maxAttempts?: number }) =>
	new S2Stream("test-stream", fakeClient, {
		baseUrl: "https://test.b.aws.s2.dev",
		accessToken: Redacted.make("test-access-token"),
		forceTransport: "fetch",
		retry,
	});

// streamAppendSpy returns SDK types (camelCase)
const makeAck = (n: number): Types.AppendAck => ({
	start: { seqNum: n - 1, timestamp: new Date(0) },
	end: { seqNum: n, timestamp: new Date(0) },
	tail: { seqNum: n, timestamp: new Date(0) },
});

describe("AppendSession", () => {
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

	it("serializes submit calls and emits acks in order", async () => {
		const stream = makeStream();

		// ensure only one in flight at a time by controlling resolution of spy
		let firstResolved = false;
		streamAppendSpy.mockImplementationOnce(async (..._args: any[]) => {
			await vi.advanceTimersByTimeAsync(10);
			firstResolved = true;
			return makeAck(1);
		});
		streamAppendSpy.mockImplementationOnce(async (..._args: any[]) => {
			expect(firstResolved).toBe(true);
			await vi.advanceTimersByTimeAsync(5);
			return makeAck(2);
		});
		// default fallback
		streamAppendSpy.mockResolvedValue(makeAck(999));

		const session = await stream.appendSession();

		const p1 = session.submit(
			AppendInput.create([AppendRecord.string({ body: "a" })]),
		);
		const p2 = session.submit(
			AppendInput.create([AppendRecord.string({ body: "b" })]),
		);

		const ticket1 = await p1;
		const ticket2 = await p2;
		const ack1 = await ticket1.ack();
		const ack2 = await ticket2.ack();

		expect(streamAppendSpy).toHaveBeenCalledTimes(2);
		expect(ack1.end.seqNum).toBe(1);
		expect(ack2.end.seqNum).toBe(2);
	});

	it("acks() stream receives emitted acks and closes on session.close()", async () => {
		const stream = makeStream();
		streamAppendSpy
			.mockResolvedValueOnce(makeAck(1))
			.mockResolvedValueOnce(makeAck(2));

		const session = await stream.appendSession();
		const acks = session.acks();

		const received: Types.AppendAck[] = [];
		const consumer = (async () => {
			for await (const ack of acks) {
				received.push(ack);
			}
		})();

		const ack1 = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "a" })]),
		);
		const ack2 = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "b" })]),
		);

		// Verify acks were received before closing
		expect(ack1).toBeTruthy();
		expect(ack2).toBeTruthy();

		// Close session - with interruptible sleep, pump will wake immediately
		await session.close();
		await consumer;

		expect(streamAppendSpy).toHaveBeenCalledTimes(2);
		expect(received.map((a) => a.end.seqNum)).toEqual([1, 2]);
	});

	it("close() waits for drain before resolving", async () => {
		const stream = makeStream();

		streamAppendSpy.mockResolvedValueOnce(makeAck(1));
		streamAppendSpy.mockResolvedValueOnce(makeAck(2));

		const session = await stream.appendSession();

		const p1 = session.submit(
			AppendInput.create([AppendRecord.string({ body: "x" })]),
		);
		const p2 = session.submit(
			AppendInput.create([AppendRecord.string({ body: "y" })]),
		);

		await Promise.all([p1, p2]);

		// Close - with interruptible sleep, pump will wake immediately
		await session.close();

		await expect(p1).resolves.toBeTruthy();
		await expect(p2).resolves.toBeTruthy();
		expect(streamAppendSpy).toHaveBeenCalledTimes(2);
	});

	it("submit after close() rejects", async () => {
		const stream = makeStream();
		streamAppendSpy.mockResolvedValue(makeAck(1));
		const session = await stream.appendSession();

		await session.close();

		await expect(
			session.submit(AppendInput.create([AppendRecord.string({ body: "x" })])),
		).rejects.toMatchObject({
			message: expect.stringContaining("AppendSession is closed"),
		});
	});

	it("error during processing rejects current and queued, clears queue", async () => {
		// Create stream with no retries to test immediate failure
		const stream = makeStream({ maxAttempts: 1 });

		// With retry enabled, the first error will trigger recovery and retry
		// So we need to mock multiple failures to exhaust retries
		streamAppendSpy.mockRejectedValue(new Error("boom"));

		const session = await stream.appendSession();

		const p1 = session.submit(
			AppendInput.create([AppendRecord.string({ body: "a" })]),
		);
		const p2 = session.submit(
			AppendInput.create([AppendRecord.string({ body: "b" })]),
		);

		// Tickets should resolve (enqueued)
		const ticket1 = await p1;
		const ticket2 = await p2;

		// Get ack promises and suppress their rejections
		const ack1 = ticket1.ack();
		const ack2 = ticket2.ack();
		ack1.catch(() => {});
		ack2.catch(() => {});

		// Advance timers to allow pump to attempt processing
		await vi.advanceTimersByTimeAsync(10);

		// But ack() should reject
		await expect(ack1).rejects.toBeTruthy();
		await expect(ack2).rejects.toBeTruthy();

		// After fatal error, session is dead - new submits should also reject
		await expect(
			session.submit(AppendInput.create([AppendRecord.string({ body: "c" })])),
		).rejects.toBeTruthy();

		// Advance more timers to ensure abort completes
		await vi.advanceTimersByTimeAsync(100);

		// Close session and wait for pump to finish to avoid unhandled rejection
		await session.close().catch(() => {});
	});

	it("updates lastSeenPosition after successful append", async () => {
		const stream = makeStream();
		streamAppendSpy.mockResolvedValue(makeAck(42));
		const session = await stream.appendSession();
		const ticket = await session.submit(
			AppendInput.create([AppendRecord.string({ body: "z" })]),
		);
		await ticket.ack();
		expect(session.lastAckedPosition()?.end.seqNum).toBe(42);
	});

	it("applies backpressure when queue exceeds maxQueuedBytes", async () => {
		const stream = makeStream();

		// Create a session with very small max queued bytes (100 bytes)
		const session = await stream.appendSession({
			maxInflightBytes: 100,
		});

		// Control when appends resolve
		let resolveFirst: any;
		const firstPromise = new Promise<Types.AppendAck>((resolve) => {
			resolveFirst = () => resolve(makeAck(1));
		});

		streamAppendSpy.mockReturnValueOnce(firstPromise);
		streamAppendSpy.mockResolvedValueOnce(makeAck(2));
		streamAppendSpy.mockResolvedValueOnce(makeAck(3));

		// Use the WritableStream interface (session is a ReadableWritablePair)
		const writer = session.writable.getWriter();

		// Submit first batch (50 bytes) - should succeed immediately
		const largeBody = "x".repeat(42); // ~50 bytes with overhead
		const p1 = writer.write(
			AppendInput.create([AppendRecord.string({ body: largeBody })]),
		);

		// Submit second batch (50 bytes) - should also queue
		const p2 = writer.write(
			AppendInput.create([AppendRecord.string({ body: largeBody })]),
		);

		// Submit third batch (50 bytes) - should block due to backpressure
		let thirdWriteStarted = false;
		const p3 = (async () => {
			await writer.write(
				AppendInput.create([AppendRecord.string({ body: largeBody })]),
			);
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
		// Allow pump loop to submit any newly unblocked writes before asserting
		await Promise.resolve();
		await Promise.resolve();
		expect(thirdWriteStarted).toBe(true);
		expect(streamAppendSpy).toHaveBeenCalledTimes(3);

		// Close - with interruptible sleep, pump will wake immediately
		await writer.close();
	});
});
