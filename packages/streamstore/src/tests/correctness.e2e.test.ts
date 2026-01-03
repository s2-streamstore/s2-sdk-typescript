import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type S2ClientOptions, S2Environment } from "../common.js";
import { S2Endpoints } from "../endpoints.js";
import {
	AppendInput,
	AppendRecord,
	BatchTransform,
	Producer,
	S2,
} from "../index.js";
import type { SessionTransports } from "../lib/stream/types.js";

const transports: SessionTransports[] = ["fetch", "s2s"];
const hasEnv = !!process.env.S2_ACCESS_TOKEN;
const describeIf = hasEnv ? describe : describe.skip;

const TEST_TIMEOUT_MS = 600_000;
const TOTAL_RECORDS = 64;

const generateBasinName = (): string => {
	const prefix = "typescript-correctness";
	const randomPart = `${Math.random().toString(36).slice(2, 10)}${Math.random()
		.toString(36)
		.slice(2, 10)}`;
	return `${prefix}-${randomPart}`.slice(0, 48);
};

const generateStreamName = (transport: string): string => {
	return `correctness-${transport}-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2, 8)}`;
};

describeIf("Correctness Integration Tests", () => {
	let s2: S2;
	let basinName: string | undefined;

	beforeAll(async () => {
		const env = S2Environment.parse();
		if (!env.accessToken) return;

		const retryConfig = {
			appendRetryPolicy: "all" as const,
			maxAttempts: 65536,
			minDelayMillis: 1000,
			maxDelayMillis: 1000,
			requestTimeoutMillis: 5_000,
		};

		const clientConfig: S2ClientOptions = {
			accessToken: env.accessToken,
			endpoints: env.endpoints ?? new S2Endpoints(),
			retry: {
				...env.retry,
				...retryConfig,
			},
		};

		s2 = new S2(clientConfig);
		basinName = generateBasinName();
		await s2.basins.create({ basin: basinName });
	}, TEST_TIMEOUT_MS);

	afterAll(async () => {
		if (!basinName) return;
		try {
			await s2.basins.delete({ basin: basinName });
		} catch {
			// best-effort cleanup
		}
	}, TEST_TIMEOUT_MS);

	it.each(transports)(
		"ensures concurrent producer and reader remain gapless (%s)",
		async (transport) => {
			if (!basinName) {
				throw new Error("Basin was not initialized");
			}

			const basin = s2.basin(basinName);
			const streamName = generateStreamName(transport);
			await basin.streams.create({ stream: streamName });
			const stream = basin.stream(streamName, { forceTransport: transport });

			try {
				const appendSession = await stream.appendSession({
					maxInflightBatches: 4,
					maxInflightBytes: 512 * 1024,
				});

				const producer = new Producer(
					new BatchTransform({
						lingerDurationMillis: 5,
						maxBatchRecords: 4,
					}),
					appendSession,
				);

				const readSession = await stream.readSession({
					start: { from: { seqNum: 0 } },
				});

				const readPromise = (async () => {
					let highestContiguousIndex = -1;
					let lastSeqNum: number | undefined;
					let observedRecords = 0;

					try {
						for await (const record of readSession) {
							const seqNum = record.seqNum;
							if (lastSeqNum === undefined) {
								expect(seqNum).toBe(0);
							} else {
								expect(seqNum).toBe(lastSeqNum + 1);
							}
							lastSeqNum = seqNum;

							expect(typeof record.body).toBe("string");
							const index = Number.parseInt(record.body ?? "", 10);
							expect(Number.isNaN(index)).toBe(false);
							expect(index).toBeGreaterThanOrEqual(0);
							expect(index).toBeLessThan(TOTAL_RECORDS);
							expect(index).toBeLessThanOrEqual(highestContiguousIndex + 1);

							if (index === highestContiguousIndex + 1) {
								highestContiguousIndex = index;
							}
							observedRecords += 1;

							if (highestContiguousIndex + 1 >= TOTAL_RECORDS) {
								// Close the read session immediately to avoid waiting for more records
								await readSession.cancel().catch(() => {});
								break;
							}
						}

						expect(highestContiguousIndex).toBe(TOTAL_RECORDS - 1);
						expect(observedRecords).toBeGreaterThanOrEqual(TOTAL_RECORDS);

						return {
							highestIndex: highestContiguousIndex,
							recordsObserved: observedRecords,
						};
					} finally {
						await readSession.cancel().catch(() => {});
					}
				})();

				const appendPromise = (async () => {
					const pendingTickets: Array<Awaited<ReturnType<Producer["submit"]>>> =
						[];

					try {
						for (let i = 0; i < TOTAL_RECORDS; i += 1) {
							// Await each submit to preserve Producer ordering guarantees.
							const ticket = await producer.submit(
								AppendRecord.string({ body: `${i}` }),
							);
							pendingTickets.push(ticket);
						}

						await Promise.all(
							pendingTickets.map(async (ticket) => {
								const ack = await ticket.ack();
								expect(ack.seqNum()).toBeGreaterThanOrEqual(0);
							}),
						);
					} finally {
						await producer.close().catch(() => {});
					}
				})();

				const [readResult] = await Promise.all([readPromise, appendPromise]);
				expect(readResult.highestIndex).toBe(TOTAL_RECORDS - 1);
			} finally {
				// Close first, then delete - racing these can cause errors
				await stream.close();
				await basin.streams.delete({ stream: streamName });
			}
		},
		TEST_TIMEOUT_MS,
	);
});
