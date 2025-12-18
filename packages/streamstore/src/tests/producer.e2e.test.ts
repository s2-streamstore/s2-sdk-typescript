import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppendRecord, BatchTransform, S2 } from "../index.js";
import type { SessionTransports } from "../lib/stream/types.js";
import { Producer } from "../producer.js";

const transports: SessionTransports[] = ["fetch", "s2s"];
const hasEnv = !!process.env.S2_ACCESS_TOKEN && !!process.env.S2_BASIN;
const describeIf = hasEnv ? describe : describe.skip;

const TOTAL_RECORDS = 200;
const SAMPLE_SIZE = 8;

const pickSampleIndexes = (count: number, sampleSize: number): number[] => {
	let seed = 0xdecafbad;
	const picks = new Set<number>();
	while (picks.size < Math.min(sampleSize, count)) {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		picks.add(seed % count);
	}
	return [...picks];
};

describeIf("Producer Integration Tests", () => {
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
		streamName = `integration-test-producer-${timestamp}`;

		const basin = s2.basin(basinName);
		await basin.streams.create({
			stream: streamName,
		});
	});

	afterAll(async () => {
		if (basinName && streamName) {
			try {
				const basin = s2.basin(basinName);
				await basin.streams.delete({ stream: streamName });
			} catch (error) {
				console.warn("Failed to cleanup producer test stream:", error);
			}
		}
	});

	it.each(transports)(
		"flushes producer batches and verifies data via unary read (%s)",
		async (transport) => {
			const basin = s2.basin(basinName);
			const stream = basin.stream(streamName, { forceTransport: transport });

			const appendSession = await stream.appendSession();
			const producer = new Producer(
				new BatchTransform({
					lingerDurationMillis: 10,
					maxBatchRecords: 25,
				}),
				appendSession,
			);

			try {
				const tickets: Array<Awaited<ReturnType<Producer["submit"]>>> = [];
				for (let i = 0; i < TOTAL_RECORDS; i++) {
					const ticket = await producer.submit(
						AppendRecord.make(`producer-${i}`),
					);
					tickets.push(ticket);
				}

				const indexesToVerify = pickSampleIndexes(TOTAL_RECORDS, SAMPLE_SIZE);
				for (const index of indexesToVerify) {
					const ack = await tickets[index]!.ack();
					const seqNum = ack.seqNum();

					const batch = await stream.read({ seq_num: seqNum, count: 1 });
					expect(batch.records).toHaveLength(1);
					expect(batch.records[0]?.body).toBe(`producer-${index}`);
				}
			} finally {
				await producer.close();
			}
		},
	);
});
