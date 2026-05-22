import { beforeAll, describe, expect, it } from "vitest";
import { type S2ClientOptions, S2Environment } from "../common.js";
import { S2 } from "../index.js";
import { TEST_TIMEOUT_MS } from "./helpers.js";

const hasEnv = !!process.env.S2_ACCESS_TOKEN;
const describeIf = hasEnv ? describe : describe.skip;

describeIf("Locations spec parity", () => {
	let s2: S2;

	beforeAll(() => {
		const env = S2Environment.parse();
		if (!env.accessToken) return;
		s2 = new S2(env as S2ClientOptions);
	});

	it(
		"lists locations",
		async () => {
			const locations = await s2.locations.list();

			expect(Array.isArray(locations)).toBe(true);
			expect(locations.length).toBeGreaterThan(0);
			for (const location of locations) {
				expect(typeof location.name).toBe("string");
				expect(location.name.length).toBeGreaterThan(0);
				expect(typeof location.isPrivate).toBe("boolean");
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"gets the default location",
		async () => {
			const location = await s2.locations.getDefault();

			expect(typeof location.name).toBe("string");
			expect(location.name.length).toBeGreaterThan(0);
			expect(typeof location.isPrivate).toBe("boolean");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"sets the default location",
		async () => {
			const before = await s2.locations.getDefault();

			const updated = await s2.locations.setDefault({
				location: before.name,
			});
			const after = await s2.locations.getDefault();

			expect(updated.name).toBe(before.name);
			expect(typeof updated.isPrivate).toBe("boolean");
			expect(after.name).toBe(before.name);
		},
		TEST_TIMEOUT_MS,
	);
});
