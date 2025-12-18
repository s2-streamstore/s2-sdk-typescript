import { beforeAll, describe, expect, it } from "vitest";
import { AppendRecord, BatchTransform, S2 } from "../index.js";
import type { SessionTransports } from "../lib/stream/types.js";
import { Producer } from "../producer.js";

const transports: SessionTransports[] = ["fetch", "s2s"];
const hasEnv = !!process.env.S2_ACCESS_TOKEN && !!process.env.S2_BASIN;
const describeIf = hasEnv ? describe : describe.skip;

const TOTAL_RECORDS = 192;
const SAMPLE_SIZE = 8;
const TEST_TIMEOUT_MS = 60_000;
const MAX_PARALLEL_SUBMITS = 64;
const CHUNK_SIZE_BYTES = 128 * 1024;

const pickSampleIndexes = (count: number, sampleSize: number): number[] => {
	let seed = 0xdecafbad;
	const picks = new Set<number>();
	while (picks.size < Math.min(sampleSize, count)) {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		picks.add(seed % count);
	}
	return [...picks];
};

const encoder = new TextEncoder();
/**
 * This e2e test codifies what we learned while debugging the Producer bug:
 * 1. Producer must await appendSession.submit per batch; otherwise, a later batch
 *    whose submit promise resolves earlier (because it hit available capacity) can
 *    overtake the slower batch that started first, violating matchSeqNum.
 * 2. The race only shows up under real-world pressure: large byte records, a tiny
 *    session window, matchSeqNum pinning, and highly parallel submit() calls.
 * 3. When the fix is reverted, this test deterministically fails with a
 *    SeqNumMismatchError (matching the image.ts repro), giving us regression coverage.
 */
const buildChunk = (index: number): Uint8Array => {
	const chunk = new Uint8Array(CHUNK_SIZE_BYTES);
	chunk.fill((index % 251) + 1);
	const marker = encoder.encode(`producer-${index}`);
	chunk.set(marker.slice(0, chunk.length));
	return chunk;
};

describeIf("Producer Integration Tests", () => {
	let s2: S2;
	let basinName: string;

	beforeAll(() => {
		const token = process.env.S2_ACCESS_TOKEN;
		const basin = process.env.S2_BASIN;
		if (!token || !basin) return;
		s2 = new S2({ accessToken: token! });
		basinName = basin!;
	});

	it.each(transports)(
		"flushes producer batches and verifies data via unary read (%s)",
		async (transport) => {
			const basin = s2.basin(basinName);
			const uniqueStreamName = `integration-test-producer-${transport}-${Date.now()}-${Math.random()
				.toString(36)
				.slice(2, 8)}`;
			await basin.streams.create({
				stream: uniqueStreamName,
			});

			const stream = basin.stream(uniqueStreamName, {
				forceTransport: transport,
			});

			const startTail = await stream.checkTail();

			const appendSession = await stream.appendSession({
				maxInflightBytes: 2 * 1024 * 1024,
				maxInflightBatches: 4,
			});
			const producer = new Producer(
				new BatchTransform({
					lingerDurationMillis: 10,
					maxBatchRecords: 1000,
					maxBatchBytes: 1024 * 1024,
					matchSeqNum: startTail.tail.seq_num,
				}),
				appendSession,
			);

			try {
				const tickets: Array<Awaited<ReturnType<Producer["submit"]>>> = [];
				const pending: Array<Promise<Awaited<ReturnType<Producer["submit"]>>>> =
					[];
				for (let i = 0; i < TOTAL_RECORDS; i++) {
					const submission = producer.submit(AppendRecord.make(buildChunk(i)));
					pending.push(submission);
					if (pending.length >= MAX_PARALLEL_SUBMITS) {
						const settled = await Promise.all(pending.splice(0));
						tickets.push(...settled);
					}
				}
				if (pending.length > 0) {
					const settled = await Promise.all(pending.splice(0));
					tickets.push(...settled);
				}

				const indexesToVerify = pickSampleIndexes(TOTAL_RECORDS, SAMPLE_SIZE);
				for (const index of indexesToVerify) {
					const ack = await tickets[index]!.ack();
					const seqNum = ack.seqNum();

					const batch = await stream.read({
						seq_num: seqNum,
						count: 1,
						as: "bytes" as const,
					});
					expect(batch.records).toHaveLength(1);
					const body = batch.records[0]?.body;
					expect(body).toBeDefined();
					expect(body?.length).toBe(CHUNK_SIZE_BYTES);
					const expected = buildChunk(index);
					expect(Buffer.from(body!)).toEqual(Buffer.from(expected));
				}
			} finally {
				await producer.close();
				try {
					await basin.streams.delete({ stream: uniqueStreamName });
				} catch (error) {
					console.warn(
						`Failed to cleanup producer test stream ${uniqueStreamName}:`,
						error,
					);
				}
			}
		},
		TEST_TIMEOUT_MS,
	);
});
