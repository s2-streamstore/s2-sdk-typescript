import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type S2ClientOptions, S2Environment } from "../common.js";
import { AppendInput, AppendRecord, S2 } from "../index.js";
import {
	TEST_TIMEOUT_MS,
	makeBasinName,
	makeStreamName,
	waitForBasinReady,
} from "./helpers.js";

const hasEnv = !!process.env.S2_ACCESS_TOKEN;
const describeIf = hasEnv ? describe : describe.skip;

describeIf("Metrics spec parity", () => {
	let s2: S2;
	let basinName = "";
	let streamName = "";

	const nowRange = (hours: number) => {
		const end = Date.now();
		const start = end - hours * 60 * 60 * 1000;
		return { start, end };
	};

	beforeAll(async () => {
		const env = S2Environment.parse();
		if (!env.accessToken) return;
		s2 = new S2(env as S2ClientOptions);
		basinName = makeBasinName("ts-metrics");
		await s2.basins.create({ basin: basinName });
		await waitForBasinReady(s2, basinName);
		const basin = s2.basin(basinName);
		streamName = makeStreamName("metrics");
		await basin.streams.create({ stream: streamName });
		await basin
			.stream(streamName)
			.append(AppendInput.create([AppendRecord.string({ body: "record" })]));
	}, TEST_TIMEOUT_MS);

	afterAll(async () => {
		if (basinName) {
			await s2.basins.delete({ basin: basinName }).catch(() => {});
		}
	}, TEST_TIMEOUT_MS);

	describe("Account metrics", () => {
		it(
			"returns active basins metric",
			async () => {
				const { start, end } = nowRange(1);
				const resp = await s2.metrics.account({
					set: "active-basins",
					start,
					end,
				});
				expect(resp.values.length).toBeGreaterThanOrEqual(0);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns account ops metric",
			async () => {
				const { start, end } = nowRange(1);
				const resp = await s2.metrics.account({
					set: "account-ops",
					start,
					end,
				});
				expect(resp.values.length).toBeGreaterThanOrEqual(0);
			},
			TEST_TIMEOUT_MS,
		);

		it.each(["minute", "hour", "day"] as const)(
			"returns account ops with %s interval",
			async (interval) => {
				const { start, end } = nowRange(interval === "day" ? 24 : 1);
				const resp = await s2.metrics.account({
					set: "account-ops",
					start,
					end,
					interval,
				});
				expect(resp.values.length).toBeGreaterThanOrEqual(0);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects missing start",
			async () => {
				const end = Date.now();
				await expect(
					s2.metrics.account({ set: "active-basins", end }),
				).rejects.toMatchObject({ status: 422 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects missing end",
			async () => {
				const start = Date.now() - 3600 * 1000;
				await expect(
					s2.metrics.account({ set: "active-basins", start }),
				).rejects.toMatchObject({ status: 422 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects missing start and end",
			async () => {
				await expect(
					s2.metrics.account({ set: "active-basins" } as any),
				).rejects.toBeTruthy();
			},
			TEST_TIMEOUT_MS,
		);

		it.each([
			{ name: "start-after-end", build: () => ({ start: Date.now(), end: Date.now() - 3600_000 }) },
			{ name: "end-too-far-future", build: () => ({ start: Date.now() - 3600_000, end: Date.now() + 600_000 }) },
			{ name: "range-too-large", build: () => ({ start: Date.now() - 40 * 24 * 3600_000, end: Date.now() }) },
		])(
			"rejects invalid time range (%s)",
			async ({ build }) => {
				const { start, end } = build();
				await expect(
					s2.metrics.account({ set: "active-basins", start, end }),
				).rejects.toMatchObject({ status: 422 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects nil args",
			async () => {
				await expect(
					s2.metrics.account(undefined as any),
				).rejects.toBeTruthy();
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"handles empty time range",
			async () => {
				const resp = await s2.metrics.account({
					set: "active-basins",
					start: 0,
					end: 3600 * 1000,
				});
				expect(resp.values.length).toBeGreaterThanOrEqual(0);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"supports all account metric sets",
			async () => {
				const { start, end } = nowRange(1);
				for (const set of ["active-basins", "account-ops"] as const) {
					const resp = await s2.metrics.account({ set, start, end });
					expect(resp.values.length).toBeGreaterThanOrEqual(0);
				}
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("Basin metrics", () => {
		it.each([
			"storage",
			"append-ops",
			"read-ops",
			"read-throughput",
			"append-throughput",
			"basin-ops",
		] as const)(
			"returns basin metric set %s",
			async (set) => {
				const { start, end } = nowRange(1);
				const resp = await s2.metrics.basin({
					basin: basinName,
					set,
					start,
					end,
				});
				expect(resp.values.length).toBeGreaterThanOrEqual(0);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns storage with hour interval",
			async () => {
				const { start, end } = nowRange(24);
				const resp = await s2.metrics.basin({
					basin: basinName,
					set: "storage",
					start,
					end,
					interval: "hour",
				});
				expect(resp.values.length).toBeGreaterThanOrEqual(0);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects invalid storage interval",
			async () => {
				const { start, end } = nowRange(1);
				await expect(
					s2.metrics.basin({
						basin: basinName,
						set: "storage",
						start,
						end,
						interval: "minute",
					}),
				).rejects.toMatchObject({ status: 422 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects missing start",
			async () => {
				const end = Date.now();
				await expect(
					s2.metrics.basin({ basin: basinName, set: "storage", end }),
				).rejects.toMatchObject({ status: 422 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects missing end",
			async () => {
				const start = Date.now() - 3600 * 1000;
				await expect(
					s2.metrics.basin({ basin: basinName, set: "storage", start }),
				).rejects.toMatchObject({ status: 422 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects missing start and end",
			async () => {
				await expect(
					s2.metrics.basin({ basin: basinName, set: "storage" } as any),
				).rejects.toBeTruthy();
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects invalid time range",
			async () => {
				const start = Date.now();
				const end = start - 3600_000;
				await expect(
					s2.metrics.basin({ basin: basinName, set: "storage", start, end }),
				).rejects.toMatchObject({ status: 422 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects empty basin name",
			async () => {
				const { start, end } = nowRange(1);
				await expect(
					s2.metrics.basin({ basin: "", set: "storage", start, end }),
				).rejects.toBeTruthy();
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects nil args",
			async () => {
				await expect(
					s2.metrics.basin(undefined as any),
				).rejects.toBeTruthy();
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"handles empty time range",
			async () => {
				const resp = await s2.metrics.basin({
					basin: basinName,
					set: "storage",
					start: 0,
					end: 3600 * 1000,
				});
				expect(resp.values.length).toBeGreaterThanOrEqual(0);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"supports all basin metric sets",
			async () => {
				const { start, end } = nowRange(1);
				for (const set of [
					"storage",
					"append-ops",
					"read-ops",
					"read-throughput",
					"append-throughput",
					"basin-ops",
				] as const) {
					const resp = await s2.metrics.basin({
						basin: basinName,
						set,
						start,
						end,
					});
					expect(resp.values.length).toBeGreaterThanOrEqual(0);
				}
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("Stream metrics", () => {
		it(
			"returns storage set",
			async () => {
				const { start, end } = nowRange(1);
				const resp = await s2.metrics.stream({
					basin: basinName,
					stream: streamName,
					set: "storage",
					start,
					end,
				});
				expect(resp.values.length).toBeGreaterThanOrEqual(0);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns storage with minute interval",
			async () => {
				const { start, end } = nowRange(1);
				const resp = await s2.metrics.stream({
					basin: basinName,
					stream: streamName,
					set: "storage",
					start,
					end,
					interval: "minute",
				});
				expect(resp.values.length).toBeGreaterThanOrEqual(0);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects invalid storage interval",
			async () => {
				const { start, end } = nowRange(1);
				await expect(
					s2.metrics.stream({
						basin: basinName,
						stream: streamName,
						set: "storage",
						start,
						end,
						interval: "hour",
					}),
				).rejects.toMatchObject({ status: 422 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects missing start",
			async () => {
				const end = Date.now();
				await expect(
					s2.metrics.stream({
						basin: basinName,
						stream: streamName,
						set: "storage",
						end,
					}),
				).rejects.toMatchObject({ status: 422 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects missing end",
			async () => {
				const start = Date.now() - 3600 * 1000;
				await expect(
					s2.metrics.stream({
						basin: basinName,
						stream: streamName,
						set: "storage",
						start,
					}),
				).rejects.toMatchObject({ status: 422 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects missing start and end",
			async () => {
				await expect(
					s2.metrics.stream({
						basin: basinName,
						stream: streamName,
						set: "storage",
					} as any),
				).rejects.toBeTruthy();
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects empty basin name",
			async () => {
				const { start, end } = nowRange(1);
				await expect(
					s2.metrics.stream({
						basin: "",
						stream: streamName,
						set: "storage",
						start,
						end,
					}),
				).rejects.toBeTruthy();
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects empty stream name",
			async () => {
				const { start, end } = nowRange(1);
				await expect(
					s2.metrics.stream({
						basin: basinName,
						stream: "",
						set: "storage",
						start,
						end,
					}),
				).rejects.toBeTruthy();
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects nil args",
			async () => {
				await expect(
					s2.metrics.stream(undefined as any),
				).rejects.toBeTruthy();
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects invalid time range",
			async () => {
				const start = Date.now();
				const end = start - 3600_000;
				await expect(
					s2.metrics.stream({
						basin: basinName,
						stream: streamName,
						set: "storage",
						start,
						end,
					}),
				).rejects.toMatchObject({ status: 422 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"handles empty time range",
			async () => {
				const resp = await s2.metrics.stream({
					basin: basinName,
					stream: streamName,
					set: "storage",
					start: 0,
					end: 3600 * 1000,
				});
				expect(resp.values.length).toBeGreaterThanOrEqual(0);
			},
			TEST_TIMEOUT_MS,
		);
	});
});
