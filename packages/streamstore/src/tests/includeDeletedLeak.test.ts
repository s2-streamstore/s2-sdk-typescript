import { describe, expect, it } from "vitest";
import { S2AccessTokens } from "../accessTokens.js";
import { S2Basins } from "../basins.js";
import { createClient, createConfig } from "../generated/client/index.js";

/**
 * Regression: `S2AccessTokens.listAll` shares the `ListAllArgs<TArgs>` shape
 * used by `S2Basins.listAll`/`S2Streams.listAll`, which adds a client-side-only
 * `includeDeleted` option. The sibling implementations destructure
 * `includeDeleted` out of `args` before paginating, but `S2AccessTokens.listAll`
 * forwarded `args` straight into `paginate` -> `list` -> the generated
 * `listAccessTokens` call. The generated query serializer emits every non-null
 * key on the `query` object, so `includeDeleted:true|false` leaked onto the
 * wire as `include_deleted=true|false` -- a query parameter the `/access-tokens`
 * endpoint does not advertise (only `prefix`/`start_after`/`limit` exist).
 *
 * These tests route through the SDK's own `createClient(createConfig(...))` with
 * a stub `fetch` that captures `Request.url`, so the asserted URLs are produced
 * by the generated client's own `buildUrl` -> `createQuerySerializer` path.
 */

const BASE_URL = "https://a.s2.dev/v1";

/** Collect all items from an async iterable, triggering any deferred fetches. */
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const item of iterable) {
		result.push(item);
	}
	return result;
}

/**
 * Build a client whose `fetch` records the outgoing `Request.url` into `holder`
 * and replies with an empty single-page list response of the given shape.
 */
function makeClient(holder: { url: string | undefined }, body: object) {
	return createClient(
		createConfig({
			auth: "ignored",
			baseUrl: BASE_URL,
			fetch: (async (input: RequestInfo | URL) => {
				const req = new Request(input);
				holder.url = req.url;
				return new Response(JSON.stringify(body), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as unknown as typeof fetch,
		}),
	);
}

describe("includeDeleted leak (faithful, SDK serializer)", () => {
	it("S2AccessTokens.listAll({ includeDeleted: true }) must NOT forward include_deleted", async () => {
		const captured: { url: string | undefined } = { url: undefined };
		const client = makeClient(captured, { access_tokens: [], has_more: false });
		const tokens = new S2AccessTokens(client);

		await collect(tokens.listAll({ includeDeleted: true }));

		expect(captured.url).toBeDefined();
		expect(captured.url).toBe(`${BASE_URL}/access-tokens`);
		expect(captured.url).not.toContain("include_deleted");
	});

	it("S2AccessTokens.listAll({ includeDeleted: false }) must NOT forward include_deleted", async () => {
		const captured: { url: string | undefined } = { url: undefined };
		const client = makeClient(captured, { access_tokens: [], has_more: false });
		const tokens = new S2AccessTokens(client);

		// `false` is a non-null primitive and would also be serialized by the
		// generated serializer (to the literal string "false"), so this case is
		// distinct from `true`.
		await collect(tokens.listAll({ includeDeleted: false }));

		expect(captured.url).toBeDefined();
		expect(captured.url).toBe(`${BASE_URL}/access-tokens`);
		expect(captured.url).not.toContain("include_deleted");
	});

	it("S2AccessTokens.listAll() (no args) produces a clean URL with no query", async () => {
		const captured: { url: string | undefined } = { url: undefined };
		const client = makeClient(captured, { access_tokens: [], has_more: false });
		const tokens = new S2AccessTokens(client);

		await collect(tokens.listAll());

		expect(captured.url).toBeDefined();
		expect(captured.url).toBe(`${BASE_URL}/access-tokens`);
		expect(captured.url).not.toContain("include_deleted");
	});

	it("S2AccessTokens.listAll({ includeDeleted, prefix }) strips include_deleted but keeps supported args", async () => {
		const captured: { url: string | undefined } = { url: undefined };
		const client = makeClient(captured, { access_tokens: [], has_more: false });
		const tokens = new S2AccessTokens(client);

		await collect(tokens.listAll({ includeDeleted: true, prefix: "tok-" }));

		expect(captured.url).toBeDefined();
		expect(captured.url).toBe(`${BASE_URL}/access-tokens?prefix=tok-`);
		expect(captured.url).not.toContain("include_deleted");
	});

	it("S2Basins.listAll({ includeDeleted: true, prefix }) strips include_deleted and keeps supported args (sibling parity)", async () => {
		const captured: { url: string | undefined } = { url: undefined };
		const client = makeClient(captured, { basins: [], has_more: false });
		const basins = new S2Basins(client, {});

		await collect(basins.listAll({ includeDeleted: true, prefix: "x" }));

		expect(captured.url).toBeDefined();
		expect(captured.url).toBe(`${BASE_URL}/basins?prefix=x`);
		expect(captured.url).not.toContain("include_deleted");
	});
});
