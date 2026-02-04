import { describe, expect, it } from "vitest";
import { type S2ClientOptions, S2Environment } from "../common.js";
import { S2 } from "../index.js";
import { TEST_TIMEOUT_MS } from "./helpers.js";

const hasEnv = !!process.env.S2_ACCESS_TOKEN;
const describeIf = hasEnv ? describe : describe.skip;
const itUnlessLite = process.env.S2_LITE ? it.skip : it;

describeIf("Client lifecycle", () => {
	it(
		"initializes with valid credentials",
		async () => {
			const env = S2Environment.parse();
			if (!env.accessToken) return;
			const client = new S2(env as S2ClientOptions);
			const resp = await client.basins.list();
			expect(Array.isArray(resp.basins)).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	itUnlessLite(
		"rejects invalid token",
		async () => {
			const env = S2Environment.parse();
			if (!env.endpoints) return;
			const client = new S2({
				accessToken: "invalid-token",
				endpoints: env.endpoints,
			});
			await expect(client.basins.list()).rejects.toMatchObject({
				status: 401,
			});
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"supports multiple instances",
		async () => {
			const env = S2Environment.parse();
			if (!env.accessToken) return;
			const clientA = new S2(env as S2ClientOptions);
			const clientB = new S2(env as S2ClientOptions);
			const [a, b] = await Promise.all([
				clientA.basins.list(),
				clientB.basins.list(),
			]);
			expect(Array.isArray(a.basins)).toBe(true);
			expect(Array.isArray(b.basins)).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"reuses a client across multiple operations",
		async () => {
			const env = S2Environment.parse();
			if (!env.accessToken) return;
			const client = new S2(env as S2ClientOptions);
			await client.basins.list();
			await client.basins.list();
		},
		TEST_TIMEOUT_MS,
	);
});
