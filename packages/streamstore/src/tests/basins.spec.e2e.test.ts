import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type S2ClientOptions, S2Environment } from "../common.js";
import { AppendInput, AppendRecord, S2 } from "../index.js";
import {
	isFreeTierLimitation,
	makeBasinName,
	makeStreamName,
	sleep,
	TEST_TIMEOUT_MS,
	waitForBasinReady,
} from "./helpers.js";

const hasEnv = !!process.env.S2_ACCESS_TOKEN;
const describeIf = hasEnv ? describe : describe.skip;

describeIf("Basins spec parity", () => {
	let s2: S2;
	const createdBasins: string[] = [];
	const listBasins: string[] = [];
	let listPrefix = "";

	const trackBasin = (name: string) => {
		createdBasins.push(name);
		return name;
	};

	const createBasin = async (
		name: string,
		config?: Parameters<S2["basins"]["create"]>[0]["config"],
		scope?: string,
	) => {
		await s2.basins.create({ basin: name, config, scope });
		await waitForBasinReady(s2, name);
	};

	beforeAll(async () => {
		const env = S2Environment.parse();
		if (!env.accessToken) return;
		s2 = new S2(env as S2ClientOptions);

		listPrefix = makeBasinName("ts-basins");
		for (let i = 0; i < 3; i += 1) {
			const name = trackBasin(`${listPrefix}-${i}`.slice(0, 48));
			await createBasin(name);
			listBasins.push(name);
		}
	}, TEST_TIMEOUT_MS);

	afterAll(async () => {
		for (const basin of createdBasins) {
			await s2.basins.delete({ basin }).catch(() => {});
		}
	}, TEST_TIMEOUT_MS);

	describe("List basins", () => {
		it(
			"lists basins",
			async () => {
				const resp = await s2.basins.list();
				expect(Array.isArray(resp.basins)).toBe(true);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns empty list for a random prefix",
			async () => {
				const resp = await s2.basins.list({
					prefix: makeBasinName("ts-none"),
				});
				expect(resp.basins).toHaveLength(0);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"filters by prefix",
			async () => {
				const resp = await s2.basins.list({ prefix: listPrefix });
				const names = resp.basins.map((b) => b.name);
				for (const name of names) {
					expect(name.startsWith(listPrefix)).toBe(true);
				}
				expect(names).toEqual(expect.arrayContaining(listBasins));
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"supports startAfter",
			async () => {
				const sorted = [...listBasins].sort();
				const startAfter = sorted[0]!;
				const resp = await s2.basins.list({
					prefix: listPrefix,
					startAfter,
				});
				expect(resp.basins.every((b) => b.name > startAfter)).toBe(true);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"respects limit",
			async () => {
				const resp = await s2.basins.list({ limit: 1 });
				expect(resp.basins.length).toBeLessThanOrEqual(1);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"paginates with startAfter",
			async () => {
				const limit = 2;
				const page1 = await s2.basins.list({
					prefix: listPrefix,
					limit,
				});
				const last = page1.basins.at(-1)?.name;
				if (!last) {
					expect(page1.basins).toHaveLength(0);
					return;
				}
				const page2 = await s2.basins.list({
					prefix: listPrefix,
					startAfter: last,
					limit,
				});
				expect(page2.basins.every((b) => b.name > last)).toBe(true);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"treats limit=0 as default",
			async () => {
				const resp = await s2.basins.list({ limit: 0 });
				expect(resp.basins.length).toBeLessThanOrEqual(1000);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"clamps limit > 1000",
			async () => {
				const resp = await s2.basins.list({ limit: 1500 });
				expect(resp.basins.length).toBeLessThanOrEqual(1000);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects startAfter less than prefix",
			async () => {
				await expect(
					s2.basins.list({ prefix: "zzzzzzzz", startAfter: "aaaaaaaa" }),
				).rejects.toMatchObject({ status: 422 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"includes deleting basins when requested",
			async () => {
				const basin = trackBasin(makeBasinName("ts-del"));
				await createBasin(basin);
				await s2.basins.delete({ basin });

				const seen: string[] = [];
				let deletingState: string | undefined;
				for await (const info of s2.basins.listAll({
					prefix: basin,
					includeDeleted: true,
				})) {
					seen.push(info.name);
					if (info.name === basin) {
						deletingState = info.state;
					}
				}
				if (seen.includes(basin)) {
					expect(deletingState).toBe("deleting");
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"iterates via listAll",
			async () => {
				const names: string[] = [];
				for await (const info of s2.basins.listAll({ prefix: listPrefix })) {
					names.push(info.name);
				}
				expect(names).toEqual(expect.arrayContaining(listBasins));
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("Create basin", () => {
		it(
			"creates a minimal basin",
			async () => {
				const basin = trackBasin(makeBasinName("ts-min"));
				const resp = await s2.basins.create({ basin });
				expect(resp.name).toBe(basin);
				await waitForBasinReady(s2, basin);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"creates with scope",
			async () => {
				const basin = trackBasin(makeBasinName("ts-scope"));
				const resp = await s2.basins.create({
					basin,
					scope: "aws:us-east-1",
				});
				expect(resp.name).toBe(basin);
				await waitForBasinReady(s2, basin);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"creates with full config",
			async () => {
				const basin = trackBasin(makeBasinName("ts-full"));
				await s2.basins.create({
					basin,
					config: {
						createStreamOnAppend: true,
						createStreamOnRead: true,
						defaultStreamConfig: {
							storageClass: "standard",
							retentionPolicy: { ageSecs: 3600 },
							timestamping: { mode: "arrival", uncapped: true },
							deleteOnEmpty: { minAgeSecs: 600 },
						},
					},
				});
				await waitForBasinReady(s2, basin);
				const cfg = await s2.basins.getConfig({ basin });
				expect(cfg.createStreamOnAppend).toBe(true);
				expect(cfg.createStreamOnRead).toBe(true);
				expect(cfg.defaultStreamConfig?.storageClass).toBe("standard");
				expect(cfg.defaultStreamConfig?.retentionPolicy).toEqual({
					ageSecs: 3600,
				});
				expect(cfg.defaultStreamConfig?.timestamping?.mode).toBe("arrival");
				expect(cfg.defaultStreamConfig?.timestamping?.uncapped).toBe(true);
				expect(cfg.defaultStreamConfig?.deleteOnEmpty?.minAgeSecs).toBe(600);
			},
			TEST_TIMEOUT_MS,
		);

		it.each([
			{ label: "createStreamOnAppend", config: { createStreamOnAppend: true } },
			{ label: "createStreamOnRead", config: { createStreamOnRead: true } },
		])(
			"creates with %s enabled",
			async ({ config }) => {
				const basin = trackBasin(makeBasinName("ts-cso"));
				await s2.basins.create({ basin, config });
				await waitForBasinReady(s2, basin);
				const cfg = await s2.basins.getConfig({ basin });
				expect(cfg.createStreamOnAppend).toBe(
					config.createStreamOnAppend ?? false,
				);
				expect(cfg.createStreamOnRead).toBe(config.createStreamOnRead ?? false);
			},
			TEST_TIMEOUT_MS,
		);

		it.each([
			{ label: "storageClass=standard", storageClass: "standard" as const },
			{ label: "storageClass=express", storageClass: "express" as const },
		])(
			"creates with %s in default stream config",
			async ({ storageClass }) => {
				const basin = trackBasin(makeBasinName("ts-sc"));
				try {
					await s2.basins.create({
						basin,
						config: {
							defaultStreamConfig: { storageClass },
						},
					});
				} catch (err) {
					if (storageClass === "express" && isFreeTierLimitation(err)) {
						return;
					}
					throw err;
				}
				await waitForBasinReady(s2, basin);
				const cfg = await s2.basins.getConfig({ basin });
				expect(cfg.defaultStreamConfig?.storageClass).toBe(storageClass);
			},
			TEST_TIMEOUT_MS,
		);

		it.each([
			{ label: "retention age", retentionPolicy: { ageSecs: 86400 } },
			{ label: "retention infinite", retentionPolicy: { infinite: {} } },
		])(
			"creates with %s in default stream config",
			async ({ retentionPolicy }) => {
				const basin = trackBasin(makeBasinName("ts-rp"));
				try {
					await s2.basins.create({
						basin,
						config: { defaultStreamConfig: { retentionPolicy } },
					});
				} catch (err) {
					if ("infinite" in retentionPolicy && isFreeTierLimitation(err)) {
						return;
					}
					throw err;
				}
				await waitForBasinReady(s2, basin);
				const cfg = await s2.basins.getConfig({ basin });
				expect(cfg.defaultStreamConfig?.retentionPolicy).toEqual(
					retentionPolicy,
				);
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
				const basin = trackBasin(makeBasinName("ts-tsm"));
				await s2.basins.create({
					basin,
					config: { defaultStreamConfig: { timestamping: { mode } } },
				});
				await waitForBasinReady(s2, basin);
				const cfg = await s2.basins.getConfig({ basin });
				expect(cfg.defaultStreamConfig?.timestamping?.mode).toBe(mode);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"creates with timestamping.uncapped",
			async () => {
				const basin = trackBasin(makeBasinName("ts-uncapped"));
				await s2.basins.create({
					basin,
					config: {
						defaultStreamConfig: { timestamping: { uncapped: true } },
					},
				});
				await waitForBasinReady(s2, basin);
				const cfg = await s2.basins.getConfig({ basin });
				expect(cfg.defaultStreamConfig?.timestamping?.uncapped).toBe(true);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"creates with deleteOnEmpty",
			async () => {
				const basin = trackBasin(makeBasinName("ts-doe"));
				await s2.basins.create({
					basin,
					config: {
						defaultStreamConfig: { deleteOnEmpty: { minAgeSecs: 3600 } },
					},
				});
				await waitForBasinReady(s2, basin);
				const cfg = await s2.basins.getConfig({ basin });
				expect(cfg.defaultStreamConfig?.deleteOnEmpty?.minAgeSecs).toBe(3600);
			},
			TEST_TIMEOUT_MS,
		);

		it.each([
			"short",
			"a".repeat(49),
			"Test-Basin-Name",
			"test_basin_name",
			"-test-basin",
			"test-basin-",
			"",
		])(
			"rejects invalid basin name (%s)",
			async (basin) => {
				await expect(s2.basins.create({ basin })).rejects.toBeTruthy();
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects duplicate basin name",
			async () => {
				const basin = trackBasin(makeBasinName("ts-dup"));
				await s2.basins.create({ basin });
				await waitForBasinReady(s2, basin);
				await expect(s2.basins.create({ basin })).rejects.toMatchObject({
					status: 409,
				});
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects create while basin is deleting",
			async () => {
				const basin = trackBasin(makeBasinName("ts-delcreate"));
				await s2.basins.create({ basin });
				await waitForBasinReady(s2, basin);
				await s2.basins.delete({ basin });

				try {
					await s2.basins.create({ basin });
					return;
				} catch (err) {
					expect(err).toMatchObject({ status: 409 });
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects retention age of zero",
			async () => {
				const basin = trackBasin(makeBasinName("ts-rp0"));
				await expect(
					s2.basins.create({
						basin,
						config: {
							defaultStreamConfig: { retentionPolicy: { ageSecs: 0 } },
						},
					}),
				).rejects.toMatchObject({ status: 422 });
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("Get basin config", () => {
		it(
			"returns config for existing basin",
			async () => {
				const basin = trackBasin(makeBasinName("ts-getcfg"));
				await s2.basins.create({ basin });
				await waitForBasinReady(s2, basin);
				const cfg = await s2.basins.getConfig({ basin });
				expect(cfg).toBeDefined();
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns 404 for non-existent basin",
			async () => {
				await expect(
					s2.basins.getConfig({ basin: makeBasinName("ts-missing") }),
				).rejects.toMatchObject({ status: 404 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns all configured fields",
			async () => {
				const basin = trackBasin(makeBasinName("ts-fields"));
				await s2.basins.create({
					basin,
					config: {
						createStreamOnAppend: true,
						createStreamOnRead: true,
						defaultStreamConfig: {
							storageClass: "standard",
							retentionPolicy: { ageSecs: 7200 },
							timestamping: { mode: "arrival", uncapped: true },
							deleteOnEmpty: { minAgeSecs: 300 },
						},
					},
				});
				await waitForBasinReady(s2, basin);
				const cfg = await s2.basins.getConfig({ basin });
				expect(cfg.createStreamOnAppend).toBe(true);
				expect(cfg.createStreamOnRead).toBe(true);
				expect(cfg.defaultStreamConfig?.storageClass).toBe("standard");
				expect(cfg.defaultStreamConfig?.retentionPolicy).toEqual({
					ageSecs: 7200,
				});
				expect(cfg.defaultStreamConfig?.timestamping?.mode).toBe("arrival");
				expect(cfg.defaultStreamConfig?.timestamping?.uncapped).toBe(true);
				expect(cfg.defaultStreamConfig?.deleteOnEmpty?.minAgeSecs).toBe(300);
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("Delete basin", () => {
		it(
			"deletes existing basin",
			async () => {
				const basin = trackBasin(makeBasinName("ts-del"));
				await s2.basins.create({ basin });
				await waitForBasinReady(s2, basin);
				await s2.basins.delete({ basin });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns 404 when deleting non-existent basin",
			async () => {
				await expect(
					s2.basins.delete({ basin: makeBasinName("ts-missing") }),
				).rejects.toMatchObject({ status: 404 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"delete is idempotent or reports already deleted",
			async () => {
				const basin = trackBasin(makeBasinName("ts-deld"));
				await s2.basins.create({ basin });
				await waitForBasinReady(s2, basin);
				await s2.basins.delete({ basin });
				try {
					await s2.basins.delete({ basin });
				} catch (err) {
					const status =
						err && typeof err === "object" && "status" in err
							? (err as { status?: number }).status
							: undefined;
					if (status !== 404) {
						throw err;
					}
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"reports deleting state after delete when listed",
			async () => {
				const basin = trackBasin(makeBasinName("ts-dstate"));
				await s2.basins.create({ basin });
				await waitForBasinReady(s2, basin);
				await s2.basins.delete({ basin });
				await sleep(500);
				const resp = await s2.basins.list({ prefix: basin });
				const info = resp.basins.find((b) => b.name === basin);
				if (info) {
					expect(info.state).toBe("deleting");
				}
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("Reconfigure basin", () => {
		it(
			"enables createStreamOnAppend",
			async () => {
				const basin = trackBasin(makeBasinName("ts-rcsa"));
				await s2.basins.create({
					basin,
					config: { createStreamOnAppend: false },
				});
				await waitForBasinReady(s2, basin);
				const cfg = await s2.basins.reconfigure({
					basin,
					createStreamOnAppend: true,
				});
				expect(cfg.createStreamOnAppend).toBe(true);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"disables createStreamOnAppend",
			async () => {
				const basin = trackBasin(makeBasinName("ts-rcsad"));
				await s2.basins.create({
					basin,
					config: { createStreamOnAppend: true },
				});
				await waitForBasinReady(s2, basin);
				const cfg = await s2.basins.reconfigure({
					basin,
					createStreamOnAppend: false,
				});
				expect(cfg.createStreamOnAppend).toBe(false);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"enables createStreamOnRead",
			async () => {
				const basin = trackBasin(makeBasinName("ts-rcsr"));
				await s2.basins.create({
					basin,
					config: { createStreamOnRead: false },
				});
				await waitForBasinReady(s2, basin);
				const cfg = await s2.basins.reconfigure({
					basin,
					createStreamOnRead: true,
				});
				expect(cfg.createStreamOnRead).toBe(true);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"auto-creates stream on append when enabled",
			async () => {
				const basin = trackBasin(makeBasinName("ts-auto-append"));
				await s2.basins.create({
					basin,
					config: {
						createStreamOnAppend: true,
						defaultStreamConfig: { retentionPolicy: { ageSecs: 3600 } },
					},
				});
				await waitForBasinReady(s2, basin);
				const basinClient = s2.basin(basin);
				const streamName = makeStreamName("auto-append");
				await basinClient
					.stream(streamName)
					.append(
						AppendInput.create([AppendRecord.string({ body: "record" })]),
					);
				const cfg = await basinClient.streams.getConfig({
					stream: streamName,
				});
				expect(cfg.retentionPolicy?.ageSecs).toBe(3600);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"auto-creates stream on read when enabled",
			async () => {
				const basin = trackBasin(makeBasinName("ts-auto-read"));
				await s2.basins.create({
					basin,
					config: {
						createStreamOnRead: true,
						defaultStreamConfig: { retentionPolicy: { ageSecs: 3600 } },
					},
				});
				await waitForBasinReady(s2, basin);
				const basinClient = s2.basin(basin);
				const streamName = makeStreamName("auto-read");
				await expect(
					basinClient.stream(streamName).read({
						start: { from: { seqNum: 0 } },
					}),
				).rejects.toMatchObject({ status: 416 });
				const cfg = await basinClient.streams.getConfig({
					stream: streamName,
				});
				expect(cfg.retentionPolicy?.ageSecs).toBe(3600);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"reconfigures default stream storage class",
			async () => {
				const basin = trackBasin(makeBasinName("ts-rcsc"));
				await s2.basins.create({
					basin,
					config: { defaultStreamConfig: { storageClass: "standard" } },
				});
				await waitForBasinReady(s2, basin);
				let cfg;
				try {
					cfg = await s2.basins.reconfigure({
						basin,
						defaultStreamConfig: { storageClass: "express" },
					});
				} catch (err) {
					if (isFreeTierLimitation(err)) return;
					throw err;
				}
				expect(cfg.defaultStreamConfig?.storageClass).toBe("express");
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"reconfigures retention to age",
			async () => {
				const basin = trackBasin(makeBasinName("ts-rpa"));
				await s2.basins.create({ basin });
				await waitForBasinReady(s2, basin);
				const cfg = await s2.basins.reconfigure({
					basin,
					defaultStreamConfig: { retentionPolicy: { ageSecs: 3600 } },
				});
				expect(cfg.defaultStreamConfig?.retentionPolicy).toEqual({
					ageSecs: 3600,
				});
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"reconfigures retention to infinite",
			async () => {
				const basin = trackBasin(makeBasinName("ts-rpi"));
				await s2.basins.create({ basin });
				await waitForBasinReady(s2, basin);
				try {
					const cfg = await s2.basins.reconfigure({
						basin,
						defaultStreamConfig: { retentionPolicy: { infinite: {} } },
					});
					expect(cfg.defaultStreamConfig?.retentionPolicy).toEqual({
						infinite: {},
					});
				} catch (err) {
					if (isFreeTierLimitation(err)) return;
					throw err;
				}
			},
			TEST_TIMEOUT_MS,
		);

		it.each([
			{ mode: "client-prefer" as const },
			{ mode: "client-require" as const },
			{ mode: "arrival" as const },
		])(
			"reconfigures timestamping mode to %s",
			async ({ mode }) => {
				const basin = trackBasin(makeBasinName("ts-rtm"));
				await s2.basins.create({ basin });
				await waitForBasinReady(s2, basin);
				const cfg = await s2.basins.reconfigure({
					basin,
					defaultStreamConfig: { timestamping: { mode } },
				});
				expect(cfg.defaultStreamConfig?.timestamping?.mode).toBe(mode);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"reconfigures timestamping.uncapped",
			async () => {
				const basin = trackBasin(makeBasinName("ts-rtu"));
				await s2.basins.create({ basin });
				await waitForBasinReady(s2, basin);
				const cfg = await s2.basins.reconfigure({
					basin,
					defaultStreamConfig: { timestamping: { uncapped: true } },
				});
				expect(cfg.defaultStreamConfig?.timestamping?.uncapped).toBe(true);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"reconfigures deleteOnEmpty",
			async () => {
				const basin = trackBasin(makeBasinName("ts-rdoe"));
				await s2.basins.create({ basin });
				await waitForBasinReady(s2, basin);
				const cfg = await s2.basins.reconfigure({
					basin,
					defaultStreamConfig: { deleteOnEmpty: { minAgeSecs: 3600 } },
				});
				expect(cfg.defaultStreamConfig?.deleteOnEmpty?.minAgeSecs).toBe(3600);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"disables deleteOnEmpty",
			async () => {
				const basin = trackBasin(makeBasinName("ts-rdoff"));
				await s2.basins.create({
					basin,
					config: {
						defaultStreamConfig: { deleteOnEmpty: { minAgeSecs: 3600 } },
					},
				});
				await waitForBasinReady(s2, basin);
				const cfg = await s2.basins.reconfigure({
					basin,
					defaultStreamConfig: { deleteOnEmpty: { minAgeSecs: 0 } },
				});
				expect(cfg.defaultStreamConfig?.deleteOnEmpty?.minAgeSecs ?? 0).toBe(0);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects reconfigure on non-existent basin",
			async () => {
				await expect(
					s2.basins.reconfigure({
						basin: makeBasinName("ts-missing"),
						createStreamOnAppend: true,
					}),
				).rejects.toMatchObject({ status: 404 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects reconfigure on deleting basin",
			async () => {
				const basin = trackBasin(makeBasinName("ts-rdel"));
				await s2.basins.create({ basin });
				await waitForBasinReady(s2, basin);
				await s2.basins.delete({ basin });
				await expect(
					s2.basins.reconfigure({ basin, createStreamOnAppend: true }),
				).rejects.toBeTruthy();
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"accepts empty reconfigure payload (no-op)",
			async () => {
				const basin = trackBasin(makeBasinName("ts-rempty"));
				await s2.basins.create({
					basin,
					config: { createStreamOnAppend: true },
				});
				await waitForBasinReady(s2, basin);
				const cfg = await s2.basins.reconfigure({ basin });
				expect(cfg.createStreamOnAppend).toBe(true);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"supports partial reconfigure",
			async () => {
				const basin = trackBasin(makeBasinName("ts-rpart"));
				await s2.basins.create({
					basin,
					config: {
						defaultStreamConfig: { retentionPolicy: { ageSecs: 3600 } },
					},
				});
				await waitForBasinReady(s2, basin);
				const cfg = await s2.basins.reconfigure({
					basin,
					defaultStreamConfig: { retentionPolicy: { ageSecs: 7200 } },
				});
				expect(cfg.defaultStreamConfig?.retentionPolicy).toEqual({
					ageSecs: 7200,
				});
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects invalid retention age on reconfigure",
			async () => {
				const basin = trackBasin(makeBasinName("ts-rp0r"));
				await s2.basins.create({ basin });
				await waitForBasinReady(s2, basin);
				await expect(
					s2.basins.reconfigure({
						basin,
						defaultStreamConfig: { retentionPolicy: { ageSecs: 0 } },
					}),
				).rejects.toMatchObject({ status: 422 });
			},
			TEST_TIMEOUT_MS,
		);
	});
});
