import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type S2ClientOptions, S2Environment } from "../common.js";
import {
	AppendInput,
	AppendRecord,
	MAX_APPEND_BYTES,
	MAX_APPEND_RECORDS,
	S2,
} from "../index.js";
import {
	TEST_TIMEOUT_MS,
	isFreeTierLimitation,
	makeBasinName,
	makeStreamName,
	sleep,
	waitForBasinReady,
} from "./helpers.js";

const hasEnv = !!process.env.S2_ACCESS_TOKEN;
const describeIf = hasEnv ? describe : describe.skip;

describeIf("Streams spec parity", () => {
	let s2: S2;
	let basinName: string;
	let basin: ReturnType<S2["basin"]>;

	const createStream = async (
		prefix: string,
		config?: Parameters<typeof basin.streams.create>[0]["config"],
	) => {
		const streamName = makeStreamName(prefix);
		await basin.streams.create({ stream: streamName, config });
		return streamName;
	};

	beforeAll(async () => {
		const env = S2Environment.parse();
		if (!env.accessToken) return;
		s2 = new S2(env as S2ClientOptions);
		basinName = makeBasinName("ts-streams");
		await s2.basins.create({ basin: basinName });
		await waitForBasinReady(s2, basinName);
		basin = s2.basin(basinName);
	}, TEST_TIMEOUT_MS);

	afterAll(async () => {
		if (basinName) {
			await s2.basins.delete({ basin: basinName }).catch(() => {});
		}
	}, TEST_TIMEOUT_MS);

	describe("List streams", () => {
		const listStreams: string[] = [];
		let listPrefix = "";

		beforeAll(async () => {
			listPrefix = makeStreamName("ts-list");
			for (let i = 0; i < 3; i += 1) {
				const name = `${listPrefix}-${i}`;
				await basin.streams.create({ stream: name });
				listStreams.push(name);
			}
		}, TEST_TIMEOUT_MS);

		afterAll(async () => {
			for (const stream of listStreams) {
				await basin.streams.delete({ stream }).catch(() => {});
			}
		}, TEST_TIMEOUT_MS);

		it(
			"lists streams",
			async () => {
				const resp = await basin.streams.list();
				expect(Array.isArray(resp.streams)).toBe(true);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"filters by prefix",
			async () => {
				const resp = await basin.streams.list({ prefix: listPrefix });
				const names = resp.streams.map((s) => s.name);
				for (const name of names) {
					expect(name.startsWith(listPrefix)).toBe(true);
				}
				expect(names).toEqual(expect.arrayContaining(listStreams));
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"respects limit",
			async () => {
				const resp = await basin.streams.list({ limit: 1 });
				expect(resp.streams.length).toBeLessThanOrEqual(1);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"paginates with startAfter",
			async () => {
				const limit = 2;
				const page1 = await basin.streams.list({
					prefix: listPrefix,
					limit,
				});
				const last = page1.streams.at(-1)?.name;
				if (!last) {
					expect(page1.streams).toHaveLength(0);
					return;
				}
				const page2 = await basin.streams.list({
					prefix: listPrefix,
					startAfter: last,
					limit,
				});
				expect(page2.streams.every((s) => s.name > last)).toBe(true);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"iterates via listAll",
			async () => {
				const names: string[] = [];
				for await (const info of basin.streams.listAll({ prefix: listPrefix })) {
					names.push(info.name);
				}
				expect(names).toEqual(expect.arrayContaining(listStreams));
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"treats limit=0 as default",
			async () => {
				const resp = await basin.streams.list({ limit: 0 });
				expect(resp.streams.length).toBeLessThanOrEqual(1000);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"clamps limit > 1000",
			async () => {
				const resp = await basin.streams.list({ limit: 1500 });
				expect(resp.streams.length).toBeLessThanOrEqual(1000);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects startAfter less than prefix",
			async () => {
				await expect(
					basin.streams.list({ prefix: "zzzzzzzz", startAfter: "aaaaaaaa" }),
				).rejects.toMatchObject({ status: 422 });
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("Create stream", () => {
		it(
			"creates a minimal stream",
			async () => {
				const streamName = await createStream("ts-min");
				try {
					expect(streamName.length).toBeGreaterThan(0);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"creates with full config",
			async () => {
				const streamName = await createStream("ts-full", {
					storageClass: "standard",
					retentionPolicy: { ageSecs: 3600 },
					timestamping: { mode: "arrival", uncapped: true },
					deleteOnEmpty: { minAgeSecs: 600 },
				});
				try {
					const cfg = await basin.streams.getConfig({ stream: streamName });
					expect(cfg.storageClass).toBe("standard");
					expect(cfg.retentionPolicy).toEqual({ ageSecs: 3600 });
					expect(cfg.timestamping?.mode).toBe("arrival");
					expect(cfg.timestamping?.uncapped).toBe(true);
					expect(cfg.deleteOnEmpty?.minAgeSecs).toBe(600);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it.each([
			{ storageClass: "standard" as const },
			{ storageClass: "express" as const },
		])(
			"creates with storageClass=%s",
			async ({ storageClass }) => {
				let streamName: string | undefined;
				try {
					streamName = await createStream("ts-sc", { storageClass });
				} catch (err) {
					if (storageClass === "express" && isFreeTierLimitation(err)) {
						return;
					}
					throw err;
				}
				try {
					const cfg = await basin.streams.getConfig({ stream: streamName });
					expect(cfg.storageClass).toBe(storageClass);
				} finally {
					if (streamName) {
						await basin.streams.delete({ stream: streamName }).catch(() => {});
					}
				}
			},
			TEST_TIMEOUT_MS,
		);

		it.each([
			{ retentionPolicy: { ageSecs: 86400 } },
			{ retentionPolicy: { infinite: {} } },
		])(
			"creates with retention policy",
			async ({ retentionPolicy }) => {
				let streamName: string | undefined;
				try {
					streamName = await createStream("ts-rp", { retentionPolicy });
				} catch (err) {
					if ("infinite" in retentionPolicy && isFreeTierLimitation(err)) {
						return;
					}
					throw err;
				}
				try {
					const cfg = await basin.streams.getConfig({ stream: streamName });
					expect(cfg.retentionPolicy).toEqual(retentionPolicy);
				} finally {
					if (streamName) {
						await basin.streams.delete({ stream: streamName }).catch(() => {});
					}
				}
			},
			TEST_TIMEOUT_MS,
		);

		it.each([
			{ mode: "client-prefer" as const },
			{ mode: "client-require" as const },
			{ mode: "arrival" as const },
		])(
			"creates with timestamping.mode=%s",
			async ({ mode }) => {
				const streamName = await createStream("ts-tsm", {
					timestamping: { mode },
				});
				try {
					const cfg = await basin.streams.getConfig({ stream: streamName });
					expect(cfg.timestamping?.mode).toBe(mode);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"creates with timestamping.uncapped",
			async () => {
				const streamName = await createStream("ts-uncapped", {
					timestamping: { uncapped: true },
				});
				try {
					const cfg = await basin.streams.getConfig({ stream: streamName });
					expect(cfg.timestamping?.uncapped).toBe(true);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"creates with deleteOnEmpty",
			async () => {
				const streamName = await createStream("ts-doe", {
					deleteOnEmpty: { minAgeSecs: 3600 },
				});
				try {
					const cfg = await basin.streams.getConfig({ stream: streamName });
					expect(cfg.deleteOnEmpty?.minAgeSecs).toBe(3600);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects empty stream name",
			async () => {
				await expect(
					basin.streams.create({ stream: "" }),
				).rejects.toBeTruthy();
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects too long stream name",
			async () => {
				const tooLong = "a".repeat(513);
				await expect(
					basin.streams.create({ stream: tooLong }),
				).rejects.toBeTruthy();
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"accepts unicode stream name",
			async () => {
				const streamName = `ts-unicode-${Date.now()}-日本語`;
				await basin.streams.create({ stream: streamName });
				await basin.streams.delete({ stream: streamName }).catch(() => {});
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects duplicate stream name",
			async () => {
				const streamName = await createStream("ts-dup");
				try {
					await expect(
						basin.streams.create({ stream: streamName }),
					).rejects.toMatchObject({ status: 409 });
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects invalid retention age zero",
			async () => {
				const streamName = makeStreamName("ts-rp0");
				await expect(
					basin.streams.create({
						stream: streamName,
						config: { retentionPolicy: { ageSecs: 0 } },
					}),
				).rejects.toMatchObject({ status: 422 });
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("Get stream config", () => {
		it(
			"returns config for existing stream",
			async () => {
				const streamName = await createStream("ts-getcfg");
				try {
					const cfg = await basin.streams.getConfig({ stream: streamName });
					expect(cfg).toBeDefined();
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns 404 for non-existent stream",
			async () => {
				await expect(
					basin.streams.getConfig({ stream: "nonexistent-stream-12345" }),
				).rejects.toMatchObject({ status: 404 });
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("Delete stream", () => {
		it(
			"deletes existing stream",
			async () => {
				const streamName = await createStream("ts-del");
				await basin.streams.delete({ stream: streamName });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns 404 for non-existent stream",
			async () => {
				await expect(
					basin.streams.delete({ stream: "nonexistent-stream-12345" }),
				).rejects.toMatchObject({ status: 404 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"marks deleted streams with deletedAt when listed",
			async () => {
				const streamName = await createStream("ts-del-list");
				await basin.streams.delete({ stream: streamName });
				await sleep(500);
				const resp = await basin.streams.list({ prefix: streamName });
				const info = resp.streams.find((s) => s.name === streamName);
				if (info) {
					expect(info.deletedAt).toBeTruthy();
				}
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("Reconfigure stream", () => {
		it(
			"changes storage class",
			async () => {
				const streamName = await createStream("ts-rcsc", {
					storageClass: "standard",
				});
				try {
					let cfg;
					try {
						cfg = await basin.streams.reconfigure({
							stream: streamName,
							storageClass: "express",
						});
					} catch (err) {
						if (isFreeTierLimitation(err)) return;
						throw err;
					}
					expect(cfg.storageClass).toBe("express");
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"changes retention to age",
			async () => {
				const streamName = await createStream("ts-rcra");
				try {
					const cfg = await basin.streams.reconfigure({
						stream: streamName,
						retentionPolicy: { ageSecs: 3600 },
					});
					expect(cfg.retentionPolicy).toEqual({ ageSecs: 3600 });
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"changes retention to infinite",
			async () => {
				const streamName = await createStream("ts-rcri");
				try {
					try {
						const cfg = await basin.streams.reconfigure({
							stream: streamName,
							retentionPolicy: { infinite: {} },
						});
						expect(cfg.retentionPolicy).toEqual({ infinite: {} });
					} catch (err) {
						if (isFreeTierLimitation(err)) return;
						throw err;
					}
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it.each([
			{ mode: "client-prefer" as const },
			{ mode: "client-require" as const },
			{ mode: "arrival" as const },
		])(
			"changes timestamping mode to %s",
			async ({ mode }) => {
				const streamName = await createStream("ts-rtm");
				try {
					const cfg = await basin.streams.reconfigure({
						stream: streamName,
						timestamping: { mode },
					});
					expect(cfg.timestamping?.mode).toBe(mode);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"changes timestamping.uncapped",
			async () => {
				const streamName = await createStream("ts-rtu");
				try {
					const cfg = await basin.streams.reconfigure({
						stream: streamName,
						timestamping: { uncapped: true },
					});
					expect(cfg.timestamping?.uncapped).toBe(true);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"changes deleteOnEmpty",
			async () => {
				const streamName = await createStream("ts-rdoe");
				try {
					const cfg = await basin.streams.reconfigure({
						stream: streamName,
						deleteOnEmpty: { minAgeSecs: 3600 },
					});
					expect(cfg.deleteOnEmpty?.minAgeSecs).toBe(3600);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"disables deleteOnEmpty",
			async () => {
				const streamName = await createStream("ts-rdoff", {
					deleteOnEmpty: { minAgeSecs: 3600 },
				});
				try {
					const cfg = await basin.streams.reconfigure({
						stream: streamName,
						deleteOnEmpty: { minAgeSecs: 0 },
					});
					expect(cfg.deleteOnEmpty?.minAgeSecs ?? 0).toBe(0);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects reconfigure on non-existent stream",
			async () => {
				await expect(
					basin.streams.reconfigure({
						stream: "nonexistent-stream-12345",
						storageClass: "standard",
					}),
				).rejects.toMatchObject({ status: 404 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects empty reconfigure payload",
			async () => {
				const streamName = await createStream("ts-rempty");
				try {
					await expect(
						basin.streams.reconfigure({ stream: streamName }),
					).rejects.toBeTruthy();
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"supports partial reconfigure",
			async () => {
				const streamName = await createStream("ts-rpart", {
					retentionPolicy: { ageSecs: 3600 },
				});
				try {
					const cfg = await basin.streams.reconfigure({
						stream: streamName,
						retentionPolicy: { ageSecs: 7200 },
					});
					expect(cfg.retentionPolicy).toEqual({ ageSecs: 7200 });
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects invalid retention age on reconfigure",
			async () => {
				const streamName = await createStream("ts-rp0r");
				try {
					await expect(
						basin.streams.reconfigure({
							stream: streamName,
							retentionPolicy: { ageSecs: 0 },
						}),
					).rejects.toMatchObject({ status: 422 });
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("Check tail", () => {
		it(
			"returns tail for empty stream",
			async () => {
				const streamName = await createStream("ts-tail-empty");
				try {
					const tail = await basin.stream(streamName).checkTail();
					expect(tail.tail.seqNum).toBe(0);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns tail after appends",
			async () => {
				const streamName = await createStream("ts-tail");
				const stream = basin.stream(streamName);
				try {
					await stream.append(
						AppendInput.create([
							AppendRecord.string({ body: "a" }),
							AppendRecord.string({ body: "b" }),
						]),
					);
					const tail = await stream.checkTail();
					expect(tail.tail.seqNum).toBe(2);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns 404 for non-existent stream",
			async () => {
				await expect(
					basin.stream("nonexistent-stream-12345").checkTail(),
				).rejects.toMatchObject({ status: 404 });
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("Append (unary)", () => {
		it(
			"appends a single record",
			async () => {
				const streamName = await createStream("ts-append1");
				const stream = basin.stream(streamName);
				try {
					const ack = await stream.append(
						AppendInput.create([AppendRecord.string({ body: "record" })]),
					);
					expect(ack.start.seqNum).toBe(0);
					expect(ack.end.seqNum).toBe(1);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"appends multiple records",
			async () => {
				const streamName = await createStream("ts-appendm");
				const stream = basin.stream(streamName);
				try {
					const ack = await stream.append(
						AppendInput.create([
							AppendRecord.string({ body: "a" }),
							AppendRecord.string({ body: "b" }),
							AppendRecord.string({ body: "c" }),
						]),
					);
					expect(ack.end.seqNum - ack.start.seqNum).toBe(3);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"preserves headers",
			async () => {
				const streamName = await createStream("ts-appendh");
				const stream = basin.stream(streamName);
				try {
					await stream.append(
						AppendInput.create([
							AppendRecord.string({
								body: "record",
								headers: [["x-test", "value"]],
							}),
						]),
					);
					const batch = await stream.read({
						start: { from: { seqNum: 0 } },
						stop: { limits: { count: 1 } },
					});
					expect(batch.records[0]?.headers).toEqual([["x-test", "value"]]);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"accepts empty body",
			async () => {
				const streamName = await createStream("ts-append-empty");
				const stream = basin.stream(streamName);
				try {
					const ack = await stream.append(
						AppendInput.create([AppendRecord.string({ body: "" })]),
					);
					expect(ack.end.seqNum).toBe(1);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"respects matchSeqNum success",
			async () => {
				const streamName = await createStream("ts-msn-ok");
				const stream = basin.stream(streamName);
				try {
					const ack = await stream.append(
						AppendInput.create([AppendRecord.string({ body: "a" })], {
							matchSeqNum: 0,
						}),
					);
					expect(ack.end.seqNum).toBe(1);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects matchSeqNum mismatch",
			async () => {
				const streamName = await createStream("ts-msn-bad");
				const stream = basin.stream(streamName);
				try {
					await stream.append(
						AppendInput.create([AppendRecord.string({ body: "a" })]),
					);
					await expect(
						stream.append(
							AppendInput.create([AppendRecord.string({ body: "b" })], {
								matchSeqNum: 0,
							}),
						),
					).rejects.toMatchObject({ status: 412 });
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns 404 for non-existent stream",
			async () => {
				await expect(
					basin.stream("nonexistent-stream-12345").append(
						AppendInput.create([AppendRecord.string({ body: "x" })]),
					),
				).rejects.toMatchObject({ status: 404 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"appends with timestamp",
			async () => {
				const streamName = await createStream("ts-ts");
				const stream = basin.stream(streamName);
				try {
					const timestamp = new Date();
					await stream.append(
						AppendInput.create([
							AppendRecord.string({ body: "record", timestamp }),
						]),
					);
					const batch = await stream.read({
						start: { from: { seqNum: 0 } },
						stop: { limits: { count: 1 } },
					});
					expect(batch.records[0]?.timestamp.getTime()).toBe(
						timestamp.getTime(),
					);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects missing timestamp on client-require stream",
			async () => {
				const streamName = await createStream("ts-tsreq", {
					timestamping: { mode: "client-require" },
				});
				const stream = basin.stream(streamName);
				try {
					await expect(
						stream.append(
							AppendInput.create([AppendRecord.string({ body: "record" })]),
						),
					).rejects.toMatchObject({ status: 422 });
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"preserves future timestamps when uncapped",
			async () => {
				const streamName = await createStream("ts-future-uncapped", {
					timestamping: { uncapped: true },
				});
				const stream = basin.stream(streamName);
				try {
					const future = new Date(Date.now() + 60_000);
					await stream.append(
						AppendInput.create([
							AppendRecord.string({ body: "record", timestamp: future }),
						]),
					);
					const batch = await stream.read({
						start: { from: { seqNum: 0 } },
						stop: { limits: { count: 1 } },
					});
					expect(batch.records[0]?.timestamp.getTime()).toBe(future.getTime());
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"caps future timestamps when uncapped=false",
			async () => {
				const streamName = await createStream("ts-future-capped", {
					timestamping: { uncapped: false },
				});
				const stream = basin.stream(streamName);
				try {
					const future = new Date(Date.now() + 60_000);
					const before = Date.now();
					await stream.append(
						AppendInput.create([
							AppendRecord.string({ body: "record", timestamp: future }),
						]),
					);
					const batch = await stream.read({
						start: { from: { seqNum: 0 } },
						stop: { limits: { count: 1 } },
					});
					const ts = batch.records[0]?.timestamp.getTime() ?? 0;
					expect(ts).toBeLessThanOrEqual(before + 5_000);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"maintains timestamp monotonicity",
			async () => {
				const streamName = await createStream("ts-tsmono");
				const stream = basin.stream(streamName);
				try {
					const now = new Date();
					const past = new Date(now.getTime() - 60_000);
					await stream.append(
						AppendInput.create([
							AppendRecord.string({ body: "first", timestamp: now }),
						]),
					);
					await stream.append(
						AppendInput.create([
							AppendRecord.string({ body: "second", timestamp: past }),
						]),
					);
					const batch = await stream.read({
						start: { from: { seqNum: 0 } },
						stop: { limits: { count: 2 } },
					});
					const t0 = batch.records[0]?.timestamp.getTime() ?? 0;
					const t1 = batch.records[1]?.timestamp.getTime() ?? 0;
					expect(t1).toBeGreaterThanOrEqual(t0);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects fencing token too long",
			async () => {
				const streamName = await createStream("ts-ft-long");
				const stream = basin.stream(streamName);
				try {
					const token = "x".repeat(37);
					await expect(
						stream.append(
							AppendInput.create([AppendRecord.string({ body: "record" })], {
								fencingToken: token,
							}),
						),
					).rejects.toMatchObject({ status: 422 });
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"accepts correct fencing token",
			async () => {
				const streamName = await createStream("ts-ft-ok");
				const stream = basin.stream(streamName);
				try {
					await stream.append(
						AppendInput.create([AppendRecord.fence("token")]),
					);
					await stream.append(
						AppendInput.create([AppendRecord.string({ body: "record" })], {
							fencingToken: "token",
						}),
					);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects wrong fencing token",
			async () => {
				const streamName = await createStream("ts-ft-bad");
				const stream = basin.stream(streamName);
				try {
					await stream.append(
						AppendInput.create([AppendRecord.fence("token")]),
					);
					await expect(
						stream.append(
							AppendInput.create([AppendRecord.string({ body: "record" })], {
								fencingToken: "wrong",
							}),
						),
					).rejects.toMatchObject({ status: 412 });
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"appends max batch size",
			async () => {
				const streamName = await createStream("ts-maxbatch");
				const stream = basin.stream(streamName);
				try {
					const records = Array.from({ length: MAX_APPEND_RECORDS }, (_v, i) =>
						AppendRecord.string({ body: `record-${i}` }),
					);
					const ack = await stream.append(AppendInput.create(records));
					expect(ack.end.seqNum - ack.start.seqNum).toBe(MAX_APPEND_RECORDS);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects too many records",
			async () => {
				const records = Array.from(
					{ length: MAX_APPEND_RECORDS + 1 },
					(_v, i) => AppendRecord.string({ body: `record-${i}` }),
				);
				expect(() => AppendInput.create(records)).toThrow();
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects empty batch",
			async () => {
				expect(() => AppendInput.create([])).toThrow();
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects batches over max bytes",
			async () => {
				const big = new Uint8Array(MAX_APPEND_BYTES);
				const records = [AppendRecord.bytes({ body: big })];
				expect(() => AppendInput.create(records)).toThrow();
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"accepts command records with empty header name",
			async () => {
				const streamName = await createStream("ts-cmd");
				const stream = basin.stream(streamName);
				try {
					const ack = await stream.append(
						AppendInput.create([AppendRecord.fence("token")]),
					);
					expect(ack.end.seqNum).toBe(1);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects empty header name with non-command",
			async () => {
				const streamName = await createStream("ts-cmd-bad");
				const stream = basin.stream(streamName);
				try {
					await expect(
						stream.append(
							AppendInput.create([
								AppendRecord.string({
									body: "record",
									headers: [["", "not-a-command"]],
								}),
							]),
						),
					).rejects.toMatchObject({ status: 422 });
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects command header with additional headers",
			async () => {
				const streamName = await createStream("ts-cmd-extra");
				const stream = basin.stream(streamName);
				try {
					await expect(
						stream.append(
							AppendInput.create([
								AppendRecord.string({
									body: "record",
									headers: [
										["", "fence"],
										["x", "y"],
									],
								}),
							]),
						),
					).rejects.toMatchObject({ status: 422 });
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("Read (unary)", () => {
		it(
			"reads from beginning on non-empty stream",
			async () => {
				const streamName = await createStream("ts-read");
				const stream = basin.stream(streamName);
				try {
					await stream.append(
						AppendInput.create([
							AppendRecord.string({ body: "a" }),
							AppendRecord.string({ body: "b" }),
						]),
					);
					const batch = await stream.read({
						start: { from: { seqNum: 0 } },
					});
					expect(batch.records.length).toBeGreaterThanOrEqual(2);
					expect(batch.records[0]?.body).toBe("a");
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"respects count limit",
			async () => {
				const streamName = await createStream("ts-read-count");
				const stream = basin.stream(streamName);
				try {
					await stream.append(
						AppendInput.create([
							AppendRecord.string({ body: "a" }),
							AppendRecord.string({ body: "b" }),
							AppendRecord.string({ body: "c" }),
						]),
					);
					const batch = await stream.read({
						start: { from: { seqNum: 0 } },
						stop: { limits: { count: 2 } },
					});
					expect(batch.records).toHaveLength(2);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns 416 when reading from tail without wait",
			async () => {
				const streamName = await createStream("ts-read-tail");
				const stream = basin.stream(streamName);
				try {
					await stream.append(
						AppendInput.create([AppendRecord.string({ body: "record" })]),
					);
					await expect(
						stream.read({ start: { from: { tailOffset: 0 } } }),
					).rejects.toMatchObject({ status: 416 });
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"reads last N records via tailOffset",
			async () => {
				const streamName = await createStream("ts-read-tailn");
				const stream = basin.stream(streamName);
				try {
					await stream.append(
						AppendInput.create([
							AppendRecord.string({ body: "a" }),
							AppendRecord.string({ body: "b" }),
							AppendRecord.string({ body: "c" }),
						]),
					);
					const batch = await stream.read({
						start: { from: { tailOffset: 2 } },
					});
					expect(batch.records).toHaveLength(2);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"reads by timestamp",
			async () => {
				const streamName = await createStream("ts-read-ts");
				const stream = basin.stream(streamName);
				try {
					const ts = new Date();
					await stream.append(
						AppendInput.create([
							AppendRecord.string({ body: "a", timestamp: ts }),
							AppendRecord.string({ body: "b" }),
						]),
					);
					const batch = await stream.read({
						start: { from: { timestamp: ts } },
					});
					expect(batch.records.length).toBeGreaterThan(0);
					expect(batch.records[0]?.timestamp.getTime()).toBeGreaterThanOrEqual(
						ts.getTime(),
					);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"respects bytes limit",
			async () => {
				const streamName = await createStream("ts-read-bytes");
				const stream = basin.stream(streamName);
				try {
					await stream.append(
						AppendInput.create([
							AppendRecord.string({ body: "first" }),
							AppendRecord.string({ body: "second" }),
						]),
					);
					const batch = await stream.read({
						start: { from: { seqNum: 0 } },
						stop: { limits: { bytes: 20 } },
					});
					expect(batch.records.length).toBeGreaterThan(0);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"reads until timestamp",
			async () => {
				const streamName = await createStream("ts-read-until");
				const stream = basin.stream(streamName);
				try {
					const t1 = new Date();
					const t2 = new Date(t1.getTime() + 1000);
					await stream.append(
						AppendInput.create([
							AppendRecord.string({ body: "a", timestamp: t1 }),
							AppendRecord.string({ body: "b", timestamp: t2 }),
						]),
					);
					const batch = await stream.read({
						start: { from: { seqNum: 0 } },
						stop: { untilTimestamp: t2 },
					});
					expect(batch.records.length).toBeGreaterThan(0);
					expect(
						batch.records.every((r) => r.timestamp.getTime() < t2.getTime()),
					).toBe(true);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns 416 when clamp=false beyond tail",
			async () => {
				const streamName = await createStream("ts-read-clamp");
				const stream = basin.stream(streamName);
				try {
					await stream.append(
						AppendInput.create([AppendRecord.string({ body: "record" })]),
					);
					await expect(
						stream.read({
							start: { from: { seqNum: 999_999 }, clamp: false },
						}),
					).rejects.toMatchObject({ status: 416 });
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns 404 for non-existent stream",
			async () => {
				await expect(
					basin.stream("nonexistent-stream-12345").read({
						start: { from: { seqNum: 0 } },
					}),
				).rejects.toMatchObject({ status: 404 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns 416 when clamping beyond tail without wait",
			async () => {
				const streamName = await createStream("ts-clamp");
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

		it(
			"long-polls with clamp=true and waitSecs",
			async () => {
				const streamName = await createStream("ts-clamp-wait");
				const stream = basin.stream(streamName);
				try {
					const batch = await stream.read({
						start: { from: { seqNum: 999_999 }, clamp: true },
						stop: { waitSecs: 1 },
					});
					expect(batch.records).toHaveLength(0);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"long-polls empty stream with waitSecs",
			async () => {
				const streamName = await createStream("ts-empty-wait");
				const stream = basin.stream(streamName);
				try {
					const batch = await stream.read({
						start: { from: { seqNum: 0 } },
						stop: { waitSecs: 1 },
					});
					expect(batch.records).toHaveLength(0);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("Command records", () => {
		it(
			"sets and clears fencing token",
			async () => {
				const streamName = await createStream("ts-fence");
				const stream = basin.stream(streamName);
				try {
					await stream.append(
						AppendInput.create([AppendRecord.fence("token")]),
					);
					await stream.append(
						AppendInput.create([AppendRecord.string({ body: "record" })], {
							fencingToken: "token",
						}),
					);
					await stream.append(
						AppendInput.create([AppendRecord.fence("")]),
					);
					await stream.append(
						AppendInput.create([AppendRecord.string({ body: "record-2" })]),
					);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"accepts trim command",
			async () => {
				const streamName = await createStream("ts-trim");
				const stream = basin.stream(streamName);
				try {
					await stream.append(
						AppendInput.create([
							AppendRecord.string({ body: "a" }),
							AppendRecord.string({ body: "b" }),
							AppendRecord.string({ body: "c" }),
						]),
					);
					await stream.append(
						AppendInput.create([AppendRecord.trim(2)]),
					);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"accepts trim to future seqNum",
			async () => {
				const streamName = await createStream("ts-trim-future");
				const stream = basin.stream(streamName);
				try {
					await stream.append(
						AppendInput.create([
							AppendRecord.string({ body: "a" }),
							AppendRecord.string({ body: "b" }),
						]),
					);
					await stream.append(
						AppendInput.create([AppendRecord.trim(10)]),
					);
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("Sessions", () => {
		it(
			"append session round-trip read",
			async () => {
				const streamName = await createStream("ts-as-rt");
				const stream = basin.stream(streamName);
				const session = await stream.appendSession();
				try {
					const ticket = await session.submit(
						AppendInput.create([
							AppendRecord.string({ body: "a" }),
							AppendRecord.string({ body: "b" }),
						]),
					);
					const ack = await ticket.ack();
					await session.close();
					const batch = await stream.read({
						start: { from: { seqNum: ack.start.seqNum } },
						stop: { limits: { count: 2 } },
					});
					expect(batch.records.map((r) => r.body)).toEqual(["a", "b"]);
				} finally {
					await session.close().catch(() => {});
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"read session can be cancelled",
			async () => {
				const streamName = await createStream("ts-rs-cancel");
				const stream = basin.stream(streamName);
				try {
					await stream.append(
						AppendInput.create([AppendRecord.string({ body: "record" })]),
					);
					const session = await stream.readSession({
						start: { from: { seqNum: 0 } },
					});
					await session.cancel();
				} finally {
					await basin.streams.delete({ stream: streamName }).catch(() => {});
				}
			},
			TEST_TIMEOUT_MS,
		);
	});
});
