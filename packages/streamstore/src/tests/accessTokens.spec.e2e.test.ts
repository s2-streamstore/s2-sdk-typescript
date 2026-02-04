import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type S2ClientOptions, S2Environment } from "../common.js";
import { S2 } from "../index.js";
import {
	isFreeTierLimitation,
	makeBasinName,
	makeStreamName,
	TEST_TIMEOUT_MS,
	waitForBasinReady,
} from "./helpers.js";

const hasEnv = !!process.env.S2_ACCESS_TOKEN;
const describeIf = hasEnv ? describe : describe.skip;

describeIf("Access tokens spec parity", () => {
	let s2: S2;
	let endpoints: S2ClientOptions["endpoints"];
	const createdTokenIds: string[] = [];
	const createdBasins: string[] = [];
	let setupOk = false;
	let basinA = "";
	let basinB = "";
	let streamA = "";

	const makeTokenId = (prefix: string) =>
		`${prefix}-${Math.random().toString(36).slice(2, 10)}`;

	const issueToken = async (
		args: Parameters<S2["accessTokens"]["issue"]>[0],
	) => {
		const resp = await s2.accessTokens.issue(args);
		createdTokenIds.push(args.id);
		return resp;
	};

	beforeAll(async () => {
		const env = S2Environment.parse();
		if (!env.accessToken) return;
		endpoints = env.endpoints;
		s2 = new S2(env as S2ClientOptions);

		try {
			basinA = makeBasinName("ts-token-a");
			basinB = makeBasinName("ts-token-b");
			await s2.basins.create({ basin: basinA });
			await s2.basins.create({ basin: basinB });
			createdBasins.push(basinA, basinB);
			await waitForBasinReady(s2, basinA);
			await waitForBasinReady(s2, basinB);
			const basinClient = s2.basin(basinA);
			streamA = makeStreamName("token-stream");
			await basinClient.streams.create({ stream: streamA });
			setupOk = true;
		} catch (err) {
			if (isFreeTierLimitation(err)) return;
			throw err;
		}
	}, TEST_TIMEOUT_MS);

	afterAll(async () => {
		for (const tokenId of createdTokenIds) {
			await s2.accessTokens.revoke({ id: tokenId }).catch(() => {});
		}
		for (const basin of createdBasins) {
			await s2.basins.delete({ basin }).catch(() => {});
		}
	}, TEST_TIMEOUT_MS);

	describe("List access tokens", () => {
		it(
			"lists tokens",
			async () => {
				const resp = await s2.accessTokens.list();
				expect(Array.isArray(resp.accessTokens)).toBe(true);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"filters by prefix",
			async () => {
				const prefix = makeTokenId("ts-list");
				await issueToken({
					id: `${prefix}-1`,
					scope: { ops: ["list-basins"] },
				});
				await issueToken({
					id: `${prefix}-2`,
					scope: { ops: ["list-basins"] },
				});
				const resp = await s2.accessTokens.list({ prefix });
				const ids = resp.accessTokens.map((t) => t.id);
				expect(ids).toEqual(
					expect.arrayContaining([`${prefix}-1`, `${prefix}-2`]),
				);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"respects limit",
			async () => {
				const resp = await s2.accessTokens.list({ limit: 1 });
				expect(resp.accessTokens.length).toBeLessThanOrEqual(1);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"paginates with startAfter",
			async () => {
				const prefix = makeTokenId("ts-page");
				await issueToken({
					id: `${prefix}-a`,
					scope: { ops: ["list-basins"] },
				});
				await issueToken({
					id: `${prefix}-b`,
					scope: { ops: ["list-basins"] },
				});
				await issueToken({
					id: `${prefix}-c`,
					scope: { ops: ["list-basins"] },
				});
				const page1 = await s2.accessTokens.list({ prefix, limit: 2 });
				const last = page1.accessTokens.at(-1)?.id;
				if (!last) return;
				const page2 = await s2.accessTokens.list({
					prefix,
					startAfter: last,
					limit: 2,
				});
				expect(page2.accessTokens.every((t) => t.id > last)).toBe(true);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"iterates via listAll",
			async () => {
				const prefix = makeTokenId("ts-iter");
				await issueToken({
					id: `${prefix}-1`,
					scope: { ops: ["list-basins"] },
				});
				await issueToken({
					id: `${prefix}-2`,
					scope: { ops: ["list-basins"] },
				});
				const ids: string[] = [];
				for await (const token of s2.accessTokens.listAll({ prefix })) {
					ids.push(token.id);
				}
				expect(ids).toEqual(
					expect.arrayContaining([`${prefix}-1`, `${prefix}-2`]),
				);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns empty list for random prefix",
			async () => {
				const resp = await s2.accessTokens.list({
					prefix: makeTokenId("ts-none"),
				});
				expect(resp.accessTokens).toHaveLength(0);
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("Issue access tokens", () => {
		it(
			"issues token with ops",
			async () => {
				const resp = await issueToken({
					id: makeTokenId("ts-ops"),
					scope: { ops: ["list-basins"] },
				});
				expect(resp.accessToken.length).toBeGreaterThan(0);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"issues token with opGroups read-only",
			async () => {
				const resp = await issueToken({
					id: makeTokenId("ts-opg-ro"),
					scope: {
						opGroups: {
							account: { read: true },
						},
					},
				});
				expect(resp.accessToken.length).toBeGreaterThan(0);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"issues token with opGroups read/write",
			async () => {
				const resp = await issueToken({
					id: makeTokenId("ts-opg-rw"),
					scope: {
						opGroups: {
							stream: { read: true, write: true },
						},
					},
				});
				expect(resp.accessToken.length).toBeGreaterThan(0);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"issues token with basin exact scope",
			async () => {
				if (!setupOk) return;
				const resp = await issueToken({
					id: makeTokenId("ts-basin-exact"),
					scope: {
						basins: { exact: basinA },
						ops: ["list-streams"],
					},
				});
				expect(resp.accessToken.length).toBeGreaterThan(0);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"issues token with basin prefix scope",
			async () => {
				const resp = await issueToken({
					id: makeTokenId("ts-basin-prefix"),
					scope: {
						basins: { prefix: "ts-" },
						ops: ["list-basins"],
					},
				});
				expect(resp.accessToken.length).toBeGreaterThan(0);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"issues token with stream exact scope",
			async () => {
				if (!setupOk) return;
				const resp = await issueToken({
					id: makeTokenId("ts-stream-exact"),
					scope: {
						basins: { exact: basinA },
						streams: { exact: streamA },
						ops: ["read"],
					},
				});
				expect(resp.accessToken.length).toBeGreaterThan(0);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"issues token with stream prefix scope",
			async () => {
				if (!setupOk) return;
				const resp = await issueToken({
					id: makeTokenId("ts-stream-prefix"),
					scope: {
						basins: { exact: basinA },
						streams: { prefix: "token-" },
						ops: ["list-streams"],
					},
				});
				expect(resp.accessToken.length).toBeGreaterThan(0);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"issues token with autoPrefixStreams",
			async () => {
				const resp = await issueToken({
					id: makeTokenId("ts-autoprefix"),
					autoPrefixStreams: true,
					scope: {
						basins: { prefix: "" },
						streams: { prefix: "tenant/" },
						ops: ["list-streams"],
					},
				});
				expect(resp.accessToken.length).toBeGreaterThan(0);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects autoPrefixStreams with exact scope",
			async () => {
				await expect(
					s2.accessTokens.issue({
						id: makeTokenId("ts-autoprefix-bad"),
						autoPrefixStreams: true,
						scope: {
							basins: { prefix: "" },
							streams: { exact: "tenant/stream" },
							ops: ["list-streams"],
						},
					}),
				).rejects.toMatchObject({ status: 422 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"issues token with expiresAt",
			async () => {
				const expiresAt = new Date(Date.now() + 60_000);
				const resp = await issueToken({
					id: makeTokenId("ts-exp"),
					expiresAt,
					scope: { ops: ["list-basins"] },
				});
				expect(resp.accessToken.length).toBeGreaterThan(0);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects duplicate token ID",
			async () => {
				const tokenId = makeTokenId("ts-dup");
				await issueToken({ id: tokenId, scope: { ops: ["list-basins"] } });
				await expect(
					s2.accessTokens.issue({
						id: tokenId,
						scope: { ops: ["list-basins"] },
					}),
				).rejects.toMatchObject({ status: 409 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects invalid token ID (empty)",
			async () => {
				await expect(
					s2.accessTokens.issue({
						id: "",
						scope: { ops: ["list-basins"] },
					}),
				).rejects.toBeTruthy();
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects invalid token ID (too long)",
			async () => {
				const id = "a".repeat(97);
				await expect(
					s2.accessTokens.issue({
						id,
						scope: { ops: ["list-basins"] },
					}),
				).rejects.toBeTruthy();
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("Revoke access tokens", () => {
		it(
			"revokes existing token",
			async () => {
				const tokenId = makeTokenId("ts-revoke");
				await issueToken({ id: tokenId, scope: { ops: ["list-basins"] } });
				await s2.accessTokens.revoke({ id: tokenId });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns 404 for non-existent token",
			async () => {
				await expect(
					s2.accessTokens.revoke({ id: makeTokenId("ts-missing") }),
				).rejects.toMatchObject({ status: 404 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"returns 404 for already revoked token",
			async () => {
				const tokenId = makeTokenId("ts-revoke-twice");
				await issueToken({ id: tokenId, scope: { ops: ["list-basins"] } });
				await s2.accessTokens.revoke({ id: tokenId });
				await expect(
					s2.accessTokens.revoke({ id: tokenId }),
				).rejects.toMatchObject({ status: 404 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rejects empty token ID",
			async () => {
				await expect(s2.accessTokens.revoke({ id: "" })).rejects.toBeTruthy();
			},
			TEST_TIMEOUT_MS,
		);
	});

	describe("Authorization & scope", () => {
		it(
			"allows basin prefix scope",
			async () => {
				if (!setupOk) return;
				const tokenId = makeTokenId("ts-basin-allow");
				const resp = await issueToken({
					id: tokenId,
					scope: {
						basins: { prefix: "ts-" },
						ops: ["create-basin", "create-stream"],
					},
				});
				const limited = new S2({
					accessToken: resp.accessToken,
					endpoints,
				});
				const name = makeBasinName("ts-scope");
				try {
					await limited.basins.create({ basin: name });
					await waitForBasinReady(s2, name);
					createdBasins.push(name);
				} catch (err) {
					if (isFreeTierLimitation(err)) return;
					throw err;
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"denies non-matching basin prefix scope",
			async () => {
				if (!setupOk) return;
				const resp = await issueToken({
					id: makeTokenId("ts-basin-deny"),
					scope: {
						basins: { prefix: "allowed-" },
						ops: ["create-basin"],
					},
				});
				const limited = new S2({
					accessToken: resp.accessToken,
					endpoints,
				});
				await expect(
					limited.basins.create({ basin: makeBasinName("denied") }),
				).rejects.toMatchObject({ status: 403 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"denies missing operation",
			async () => {
				const resp = await issueToken({
					id: makeTokenId("ts-op-deny"),
					scope: { ops: ["list-basins"] },
				});
				const limited = new S2({
					accessToken: resp.accessToken,
					endpoints,
				});
				await expect(
					limited.basins.create({ basin: makeBasinName("shouldfail") }),
				).rejects.toMatchObject({ status: 403 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"denies permission escalation",
			async () => {
				const tokenId = makeTokenId("ts-limited");
				const resp = await issueToken({
					id: tokenId,
					scope: {
						ops: ["list-basins", "issue-access-token"],
						accessTokens: { prefix: "" },
					},
				});
				const limited = new S2({
					accessToken: resp.accessToken,
					endpoints,
				});
				await expect(
					limited.accessTokens.issue({
						id: makeTokenId("ts-escalate"),
						scope: { ops: ["create-basin"] },
					}),
				).rejects.toMatchObject({ status: 403 });
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"denies list-access-tokens without permission",
			async () => {
				const resp = await issueToken({
					id: makeTokenId("ts-no-list"),
					scope: { ops: ["list-basins"] },
				});
				const limited = new S2({
					accessToken: resp.accessToken,
					endpoints,
				});
				await expect(limited.accessTokens.list()).rejects.toMatchObject({
					status: 403,
				});
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"denies cross-basin access",
			async () => {
				if (!setupOk) return;
				const resp = await issueToken({
					id: makeTokenId("ts-cross"),
					scope: {
						basins: { exact: basinA },
						streams: { prefix: "" },
						ops: ["create-stream"],
					},
				});
				const limited = new S2({
					accessToken: resp.accessToken,
					endpoints,
				});
				await expect(
					limited.basin(basinB).streams.create({ stream: "test-stream" }),
				).rejects.toMatchObject({ status: 403 });
			},
			TEST_TIMEOUT_MS,
		);
	});
});
