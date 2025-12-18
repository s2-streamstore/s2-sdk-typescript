import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppendRecord, S2 } from "../index.js";
import type { AppendArgs, SessionTransports } from "../lib/stream/types.js";

const transports: SessionTransports[] = ["fetch", "s2s"];
const ILLEGAL_RECORD_BYTES = 1_100_000;
const hasEnv = !!process.env.S2_ACCESS_TOKEN && !!process.env.S2_BASIN;
const describeIf = hasEnv ? describe : describe.skip;

describeIf("AppendSession Integration Tests", () => {
	let s2: S2;
	let basinName: string;
	let streamName: string;

	beforeAll(() => {
		const token = process.env.S2_ACCESS_TOKEN;
		const basin = process.env.S2_BASIN;
		if (!token || !basin) return;
		s2 = new S2({ accessToken: token! });
		basinName = basin!;
	});

	beforeAll(async () => {
		// Use a unique stream name for each test run
		const timestamp = Date.now();
		streamName = `integration-test-append-${timestamp}`;

		const basin = s2.basin(basinName);
		// Create a test stream (will be cleaned up if needed)
		await basin.streams.create({
			stream: streamName,
		});
	});

	afterAll(async () => {
		// Clean up: delete the test stream
		if (basinName && streamName) {
			try {
				const basin = s2.basin(basinName);
				await basin.streams.delete({ stream: streamName });
			} catch (error) {
				// Ignore cleanup errors
				console.warn("Failed to cleanup test stream:", error);
			}
		}
	});

	it.each(transports)(
		"should append records sequentially using appendSession (%s)",
		async (transport) => {
			const basin = s2.basin(basinName);
			const stream = basin.stream(streamName, { forceTransport: transport });

			const session = await stream.appendSession();

			// Submit multiple records sequentially
			const records = [
				AppendRecord.make("test-record-1"),
				AppendRecord.make("test-record-2"),
				AppendRecord.make("test-record-3"),
			];

			const ticket1 = await session.submit([records[0]!]);
			const ack1 = await ticket1.ack();
			const ticket2 = await session.submit([records[1]!]);
			const ack2 = await ticket2.ack();
			const ticket3 = await session.submit([records[2]!]);
			const ack3 = await ticket3.ack();

			// Verify acks are sequential
			expect(ack1.end.seq_num).toBeGreaterThan(0);
			expect(ack2.end.seq_num).toBe(ack1.end.seq_num + 1);
			expect(ack3.end.seq_num).toBe(ack2.end.seq_num + 1);

			// Verify timestamps are present
			expect(ack1.end.timestamp).toBeGreaterThan(0);
			expect(ack2.end.timestamp).toBeGreaterThanOrEqual(ack1.end.timestamp);
			expect(ack3.end.timestamp).toBeGreaterThanOrEqual(ack2.end.timestamp);

			await session.close();
		},
	);

	it.each(transports)(
		"should handle multiple records in a single submit (%s)",
		async (transport) => {
			const basin = s2.basin(basinName);
			const stream = basin.stream(streamName, { forceTransport: transport });

			const session = await stream.appendSession();

			const records = [
				AppendRecord.make("batch-1"),
				AppendRecord.make("batch-2"),
				AppendRecord.make("batch-3"),
			];

			const ticket = await session.submit(records);
			const ack = await ticket.ack();

			// Verify all records were appended
			expect(ack.end.seq_num - ack.start.seq_num).toBe(3);
			expect(ack.end.seq_num).toBeGreaterThan(0);

			await session.close();
		},
	);

	it.each(transports)(
		"should emit acks via acks() stream (%s)",
		async (transport) => {
			const basin = s2.basin(basinName);
			const stream = basin.stream(streamName, { forceTransport: transport });

			const session = await stream.appendSession();

			// Collect acks in background
			const collectedAcks: Array<{ seq_num: number }> = [];
			const acksPromise = (async () => {
				for await (const ack of session.acks()) {
					collectedAcks.push({ seq_num: ack.end.seq_num });
					// Collect all acks until stream closes
				}
			})();

			// Submit records
			await (await session.submit([AppendRecord.make("ack-test-1")])).ack();
			await (await session.submit([AppendRecord.make("ack-test-2")])).ack();
			await (await session.submit([AppendRecord.make("ack-test-3")])).ack();

			// Close session to close acks stream
			await session.close();
			await acksPromise;

			// Verify we received all acks
			expect(collectedAcks.length).toBeGreaterThanOrEqual(3);
			expect(collectedAcks[0]?.seq_num).toBeGreaterThan(0);
		},
	);

	it.each(transports)(
		"should update lastSeenPosition after successful append (%s)",
		async (transport) => {
			const basin = s2.basin(basinName);
			const stream = basin.stream(streamName, { forceTransport: transport });

			const session = await stream.appendSession();

			// Initially, lastSeenPosition should be undefined
			expect(session.lastAckedPosition()).toBeUndefined();

			// Submit a record
			const ticket = await session.submit([AppendRecord.make("position-test")]);
			const ack = await ticket.ack();

			// Verify lastSeenPosition is updated
			expect(session.lastAckedPosition()).toBeDefined();
			expect(session.lastAckedPosition()?.end.seq_num).toBe(ack.end.seq_num);
			expect(session.lastAckedPosition()?.end.timestamp).toBe(
				ack.end.timestamp,
			);

			await session.close();
		},
	);

	it.each(transports)(
		"should support appending records with headers (%s)",
		async (transport) => {
			const basin = s2.basin(basinName);
			const stream = basin.stream(streamName, { forceTransport: transport });

			const session = await stream.appendSession();

			const record = AppendRecord.make("header-test", [
				["custom-header", "custom-value"],
				["another-header", "another-value"],
			]);

			const ticket = await session.submit([record]);
			const ack = await ticket.ack();

			expect(ack.end.seq_num).toBeGreaterThan(0);

			await session.close();
		},
	);

	it.each(transports)(
		"should support appending bytes records (%s)",
		async (transport) => {
			const basin = s2.basin(basinName);
			const stream = basin.stream(streamName, { forceTransport: transport });

			const session = await stream.appendSession();

			const body = new TextEncoder().encode("bytes-record-test");
			const record = AppendRecord.make(body);

			const ticket = await session.submit([record]);
			const ack = await ticket.ack();

			expect(ack.end.seq_num).toBeGreaterThan(0);

			await session.close();
		},
	);

	it.each(transports)(
		"propagates writable stream errors when a batch fails (%s)",
		async (transport) => {
			const basin = s2.basin(basinName);
			const stream = basin.stream(streamName, { forceTransport: transport });

			const session = await stream.appendSession();

			const batches: AppendArgs[] = Array.from(
				{ length: 4 },
				(_v, i): AppendArgs => ({
					records: [AppendRecord.make(`pipe-batch-${i}`)],
				}),
			);
			batches.push({
				records: [AppendRecord.make("pipe-batch-fail")],
				matchSeqNum: 0, // guaranteed to mismatch once earlier batches advance the tail
			});

			const readable = new ReadableStream<AppendArgs>({
				start(controller) {
					for (const batch of batches) {
						controller.enqueue(batch);
					}
					controller.close();
				},
			});

			await expect(readable.pipeTo(session.writable)).rejects.toMatchObject({
				message: expect.stringContaining("sequence number mismatch"),
			});

			await session.close().catch(() => {});
		},
	);

	it.each(transports)(
		"acks() emits existing successes then throws on fatal error (%s)",
		async (transport) => {
			const basin = s2.basin(basinName);
			const stream = basin.stream(streamName, { forceTransport: transport });

			const session = await stream.appendSession();

			const batches: AppendArgs[] = Array.from(
				{ length: 4 },
				(_v, i): AppendArgs => ({
					records: [AppendRecord.make(`acks-pipe-${i}`)],
				}),
			);
			batches.push({
				records: [AppendRecord.make("acks-pipe-fail")],
				matchSeqNum: 0,
			});

			const ackSeqs: number[] = [];
			const acksPromise = (async () => {
				try {
					for await (const ack of session.acks()) {
						ackSeqs.push(ack.end.seq_num);
					}
				} catch (err) {
					throw err;
				}
			})();

			const readable = new ReadableStream<AppendArgs>({
				start(controller) {
					for (const batch of batches) {
						controller.enqueue(batch);
					}
					controller.close();
				},
			});

			await expect(readable.pipeTo(session.writable)).rejects.toMatchObject({
				message: expect.stringContaining("sequence number mismatch"),
			});

			await expect(acksPromise).rejects.toMatchObject({
				message: expect.stringContaining("sequence number mismatch"),
			});

			expect(ackSeqs).toHaveLength(4);

			await session.close().catch(() => {});
		},
	);

	it.each(transports)(
		"should handle concurrent submits with proper ordering (%s)",
		async (transport) => {
			const basin = s2.basin(basinName);
			const stream = basin.stream(streamName, { forceTransport: transport });

			const session = await stream.appendSession();

			// Submit multiple records concurrently
			const promises = [
				session.submit([AppendRecord.make("concurrent-1")]),
				session.submit([AppendRecord.make("concurrent-2")]),
				session.submit([AppendRecord.make("concurrent-3")]),
				session.submit([AppendRecord.make("concurrent-4")]),
				session.submit([AppendRecord.make("concurrent-5")]),
			];

			const tickets = await Promise.all(promises);
			const acks = await Promise.all(tickets.map((ticket) => ticket.ack()));

			// Verify all acks are sequential (session should serialize them)
			for (let i = 1; i < acks.length; i++) {
				expect(acks[i]?.end.seq_num).toBe((acks[i - 1]?.end.seq_num ?? 0) + 1);
			}

			await session.close();
		},
	);

	it.each(transports)(
		"should reject submit after close() (%s)",
		async (transport) => {
			const basin = s2.basin(basinName);
			const stream = basin.stream(streamName, { forceTransport: transport });

			const session = await stream.appendSession();

			await session.close();

			// Submit after close should reject
			await expect(
				session.submit([AppendRecord.make("after-close")]),
			).rejects.toThrow();
		},
	);

	it.each(transports)(
		"should wait for drain on close() (%s)",
		async (transport) => {
			const basin = s2.basin(basinName);
			const stream = basin.stream(streamName, { forceTransport: transport });

			const session = await stream.appendSession();

			// Submit records
			const p1 = session.submit([AppendRecord.make("drain-1")]);
			const p2 = session.submit([AppendRecord.make("drain-2")]);

			// Close should wait for all appends to complete
			await session.close();

			// Both promises should be resolved
			const ticket1 = await p1;
			const ticket2 = await p2;
			const ack1 = await ticket1.ack();
			const ack2 = await ticket2.ack();

			expect(ack1.end.seq_num).toBeGreaterThan(0);
			expect(ack2.end.seq_num).toBe(ack1.end.seq_num + 1);
		},
	);

	it.each(transports)(
		"should drain pending appends on close and reject subsequent submits (%s)",
		async (transport) => {
			const basin = s2.basin(basinName);
			const stream = basin.stream(streamName, { forceTransport: transport });

			const session = await stream.appendSession();

			// Submit a few records
			const p1 = session.submit([AppendRecord.make("item-0")]);
			const p2 = session.submit([AppendRecord.make("item-1")]);
			const p3 = session.submit([AppendRecord.make("item-2")]);

			// Close should wait for all pending appends to complete
			await session.close();

			// Subsequent submit after close should fail
			await expect(
				session.submit([AppendRecord.make("item-3")]),
			).rejects.toThrow(/closed/i);

			// All three promises should be resolved successfully
			const ticket1 = await p1;
			const ticket2 = await p2;
			const ticket3 = await p3;
			const ack1 = await ticket1.ack();
			const ack2 = await ticket2.ack();
			const ack3 = await ticket3.ack();

			expect(ack1.end.seq_num).toBeGreaterThan(0);
			expect(ack2.end.seq_num).toBe(ack1.end.seq_num + 1);
			expect(ack3.end.seq_num).toBe(ack2.end.seq_num + 1);
		},
	);

	it.each(transports)(
		"propagates writable errors for oversized records (%s)",
		async (transport) => {
			const basin = s2.basin(basinName);
			const stream = basin.stream(streamName, { forceTransport: transport });

			const session = await stream.appendSession();

			const oversized = new Uint8Array(ILLEGAL_RECORD_BYTES);
			oversized.fill(0xab);

			const batches: AppendArgs[] = [
				{ records: [AppendRecord.make("ok-0")] },
				{ records: [AppendRecord.make("ok-1")] },
				{ records: [AppendRecord.make("ok-2")] },
				{ records: [AppendRecord.make("ok-3")] },
				{ records: [AppendRecord.make(oversized)] },
			];

			const readable = new ReadableStream<AppendArgs>({
				start(controller) {
					for (const batch of batches) {
						controller.enqueue(batch);
					}
					controller.close();
				},
			});

			await expect(readable.pipeTo(session.writable)).rejects.toMatchObject({
				message: expect.stringContaining("exceeds maximum"),
			});

			await session.close().catch(() => {});
		},
	);
});
