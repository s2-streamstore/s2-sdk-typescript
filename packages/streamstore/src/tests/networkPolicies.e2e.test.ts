import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type S2ClientOptions, S2Environment } from "../common.js";
import { S2 } from "../index.js";
import { TEST_TIMEOUT_MS } from "./helpers.js";

// s2-lite does not implement network policies.
const hasEnv = !!process.env.S2_ACCESS_TOKEN && !process.env.S2_LITE;
const describeIf = hasEnv ? describe : describe.skip;

describeIf("Network policies", () => {
	let s2: S2;
	let endpoints: S2ClientOptions["endpoints"];
	const prefix = `ts-netpol-${Math.random().toString(36).slice(2, 10)}`;
	const tokenId = `${prefix}-token`;

	beforeAll(() => {
		const env = S2Environment.parse();
		endpoints = env.endpoints;
		s2 = new S2(env as S2ClientOptions);
	});

	afterAll(async () => {
		await s2.accessTokens.revoke({ id: tokenId }).catch(() => {});
		for await (const policy of s2.networkPolicies.listAll({ prefix })) {
			await s2.networkPolicies.delete({ id: policy.slug }).catch(() => {});
		}
	}, TEST_TIMEOUT_MS);

	it(
		"binds a token to a policy that the service then enforces",
		async () => {
			// TEST-NET-3: never the address this test runs from.
			const policy = { publicNet: { cidrs: ["203.0.113.0/24"] } };
			const created = await s2.networkPolicies.create({
				slug: `${prefix}-a`,
				policy,
			});
			expect(created.id).toMatch(new RegExp(`^${prefix}-a\\.`));
			expect(created.createdAt).toBeInstanceOf(Date);
			expect(created.policy).toEqual(policy);
			await s2.networkPolicies.create({
				slug: `${prefix}-b`,
				policy: {
					privateNet: { aws: { vpceIds: ["vpce-0123456789abcdef0"] } },
				},
			});

			const bySlug = await s2.networkPolicies.get({ id: created.slug });
			const byRef = await s2.networkPolicies.get({ id: created.id });
			expect(byRef).toEqual(bySlug);
			expect(bySlug.id).toBe(created.id);

			const slugs: string[] = [];
			for await (const p of s2.networkPolicies.listAll({ prefix, limit: 1 })) {
				slugs.push(p.slug);
			}
			expect(slugs).toEqual([`${prefix}-a`, `${prefix}-b`]);

			const { accessToken } = await s2.accessTokens.issue({
				id: tokenId,
				scope: { ops: ["list-basins"] },
				networkPolicy: created.slug,
			});
			const listed = await s2.accessTokens.list({ prefix: tokenId });
			expect(listed.accessTokens[0]?.networkPolicy).toBe(created.id);

			const restricted = new S2({ accessToken, endpoints });
			await expect(restricted.basins.list()).rejects.toMatchObject({
				status: 403,
			});
			await expect(
				s2.networkPolicies.delete({ id: created.slug }),
			).rejects.toMatchObject({ status: 409 });

			await s2.accessTokens.revoke({ id: tokenId });
			await s2.networkPolicies.delete({ id: created.slug });
			await expect(
				s2.networkPolicies.get({ id: created.slug }),
			).rejects.toMatchObject({ status: 404 });
		},
		TEST_TIMEOUT_MS,
	);
});
