import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type S2ClientOptions, S2Environment } from "../common.js";
import { AppendInput, AppendRecord, S2, type S2Basin } from "../index.js";
import { meteredBytes } from "../utils.js";
import { makeBasinName, makeStreamName, TEST_TIMEOUT_MS } from "./helpers.js";

const hasEnv = !!process.env.S2_ACCESS_TOKEN;
const describeIf = hasEnv ? describe : describe.skip;

const DEFAULT_RETENTION_AGE_SECS = 3600;
type MeteredInput = Parameters<typeof meteredBytes>[0];

describeIf("Spec Integration Tests", () => {
	let s2: S2;
	let basinName: string;
	let autoBasinName: string;
	let basin: S2Basin;
	let autoBasin: S2Basin;

	const createStream = async (target: S2Basin, prefix: string) => {
		const streamName = makeStreamName(prefix);
		await target.streams.create({ stream: streamName });
		return streamName;
	};

	beforeAll(async () => {
		const env = S2Environment.parse();
		if (!env.accessToken) return;
		s2 = new S2(env as S2ClientOptions);

		basinName = makeBasinName("typescript-spec");
		autoBasinName = makeBasinName("typescript-auto");

		await s2.basins.create({ basin: basinName });
		await s2.basins.create({
			basin: autoBasinName,
			config: {
				createStreamOnAppend: true,
				createStreamOnRead: true,
				defaultStreamConfig: {
					retentionPolicy: { ageSecs: DEFAULT_RETENTION_AGE_SECS },
				},
			},
		});

		basin = s2.basin(basinName);
		autoBasin = s2.basin(autoBasinName);
	}, TEST_TIMEOUT_MS);

	afterAll(async () => {
		if (!s2) return;
		if (autoBasinName) {
			await s2.basins.delete({ basin: autoBasinName }).catch(() => {});
		}
		if (basinName) {
			await s2.basins.delete({ basin: basinName }).catch(() => {});
		}
	}, TEST_TIMEOUT_MS);

	describe("Read semantics (unary)", () => {
		it(
			"returns 416 when reading an empty stream from seqNum=0",
			async () => {
				const streamName = await createStream(basin, "empty-read");
				const stream = basin.stream(streamName);

				try {
					await expect(
						stream.read({ start: { from: { seqNum: 0 } } }),
					).rejects.toMatchObject({ status: 416 });
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns empty records when count=0",
			async () => {
				const streamName = await createStream(basin, "count-zero");
				const stream = basin.stream(streamName);

				try {
					await stream.append(
						AppendInput.create([AppendRecord.string({ body: "record" })]),
					);
					const batch = await stream.read({
						start: { from: { seqNum: 0 } },
						stop: { limits: { count: 0 } },
					});
					expect(batch.records).toHaveLength(0);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns empty records when bytes=0",
			async () => {
				const streamName = await createStream(basin, "bytes-zero");
				const stream = basin.stream(streamName);

				try {
					await stream.append(
						AppendInput.create([AppendRecord.string({ body: "record" })]),
					);
					const batch = await stream.read({
						start: { from: { seqNum: 0 } },
						stop: { limits: { bytes: 0 } },
					});
					expect(batch.records).toHaveLength(0);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"clamps count to 1000 on unary read",
			async () => {
				const streamName = await createStream(basin, "count-clamp");
				const stream = basin.stream(streamName);

				try {
					const batch1 = Array.from({ length: 1000 }, (_, i) =>
						AppendRecord.string({ body: `record-${i}` }),
					);
					const batch2 = Array.from({ length: 100 }, (_, i) =>
						AppendRecord.string({ body: `extra-${i}` }),
					);
					await stream.append(AppendInput.create(batch1));
					await stream.append(AppendInput.create(batch2));

					const batch = await stream.read({
						start: { from: { seqNum: 0 } },
						stop: { limits: { count: 5000 } },
					});
					expect(batch.records).toHaveLength(1000);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"clamps bytes to 1 MiB on unary read",
			async () => {
				const streamName = await createStream(basin, "bytes-clamp");
				const stream = basin.stream(streamName);

				try {
					const body = new Uint8Array(64 * 1024);
					body.fill(1);

					const batch1 = Array.from({ length: 15 }, () =>
						AppendRecord.bytes({ body }),
					);
					const batch2 = Array.from({ length: 15 }, () =>
						AppendRecord.bytes({ body }),
					);

					const batch1Bytes = batch1.reduce(
						(sum, r) => sum + r.meteredBytes,
						0,
					);
					const batch2Bytes = batch2.reduce(
						(sum, r) => sum + r.meteredBytes,
						0,
					);
					expect(batch1Bytes).toBeLessThanOrEqual(1024 * 1024);
					expect(batch2Bytes).toBeLessThanOrEqual(1024 * 1024);
					expect(batch1Bytes + batch2Bytes).toBeGreaterThan(1024 * 1024);

					await stream.append(AppendInput.create(batch1));
					await stream.append(AppendInput.create(batch2));

					const batch = await stream.read(
						{
							start: { from: { seqNum: 0 } },
							stop: { limits: { bytes: 10_000_000 } },
						},
						{ as: "bytes" },
					);
					const totalRead = batch.records.reduce(
						(sum, r) => sum + meteredBytes(r as unknown as MeteredInput),
						0,
					);
					expect(totalRead).toBeGreaterThan(0);
					expect(totalRead).toBeLessThanOrEqual(1024 * 1024);
					expect(batch.records.length).toBeLessThan(
						batch1.length + batch2.length,
					);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects timestamp >= until",
			async () => {
				const streamName = await createStream(basin, "ts-until");
				const stream = basin.stream(streamName);

				try {
					await stream.append(
						AppendInput.create([AppendRecord.string({ body: "record" })]),
					);

					const baseline = await stream.read({
						start: { from: { seqNum: 0 } },
						stop: { limits: { count: 1 } },
					});
					const ts = baseline.records[0]?.timestamp;
					if (!ts) {
						throw new Error("Expected baseline timestamp");
					}

					await expect(
						stream.read({
							start: { from: { timestamp: ts } },
							stop: { untilTimestamp: ts },
						}),
					).rejects.toMatchObject({ status: 422 });
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"saturates tailOffset beyond tail to start",
			async () => {
				const streamName = await createStream(basin, "tail-offset");
				const stream = basin.stream(streamName);

				try {
					await stream.append(
						AppendInput.create([
							AppendRecord.string({ body: "one" }),
							AppendRecord.string({ body: "two" }),
							AppendRecord.string({ body: "three" }),
						]),
					);

					const batch = await stream.read({
						start: { from: { tailOffset: 10 } },
					});
					expect(batch.records).toHaveLength(3);
					expect(batch.records[0]?.seqNum).toBe(0);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns 416 when clamping beyond tail without wait",
			async () => {
				const streamName = await createStream(basin, "clamp-tail");
				const stream = basin.stream(streamName);

				try {
					await stream.append(
						AppendInput.create([AppendRecord.string({ body: "record" })]),
					);
					await expect(
						stream.read({
							start: { from: { seqNum: 999_999 }, clamp: true },
						}),
					).rejects.toMatchObject({ status: 416 });
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("Auto-create streams", () => {
		it(
			"auto-creates stream on append and applies default config",
			async () => {
				const streamName = makeStreamName("auto-append");
				const stream = autoBasin.stream(streamName);

				await stream.append(
					AppendInput.create([AppendRecord.string({ body: "auto" })]),
				);
				const cfg = await autoBasin.streams.getConfig({ stream: streamName });
				const retention = cfg.retentionPolicy;
				if (!retention || !("ageSecs" in retention)) {
					throw new Error("Expected ageSecs retention policy");
				}
				expect(retention.ageSecs).toBe(DEFAULT_RETENTION_AGE_SECS);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"auto-creates stream on read",
			async () => {
				const streamName = makeStreamName("auto-read");
				const stream = autoBasin.stream(streamName);

				await expect(
					stream.read({ start: { from: { seqNum: 0 } } }),
				).rejects.toMatchObject({ status: 416 });

				const cfg = await autoBasin.streams.getConfig({ stream: streamName });
				const retention = cfg.retentionPolicy;
				if (!retention || !("ageSecs" in retention)) {
					throw new Error("Expected ageSecs retention policy");
				}
				expect(retention.ageSecs).toBe(DEFAULT_RETENTION_AGE_SECS);
			},
			TEST_TIMEOUT_MS,
		);
	});

});
