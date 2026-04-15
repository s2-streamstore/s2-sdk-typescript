import { describe, expect, it } from "vitest";
import { EndpointTemplate } from "../../endpoints.js";

/**
 * Issue #167: Endpoint query/fragment is dropped when endpoint has no explicit path.
 *
 * `hasExplicitPath()` only returns true when the first post-authority delimiter
 * is `/`. For endpoints like `host?q=1` (where the first delimiter is `?`),
 * `explicitPathProvided` is false, so the constructor defaults the path to
 * `/v1` and silently discards the parsed query string and hash fragment.
 *
 * This means endpoint configuration like `host?token=secret` silently loses
 * the API token, leading to failed requests without any diagnostic.
 *
 * The fix (applied in #178) rejects endpoints that include query strings or
 * hash fragments entirely, since they cannot be correctly preserved through
 * the URL construction pipeline. This prevents the silent data loss.
 */
describe("Issue #167: endpoints without explicit path must not silently drop query/fragment", () => {
	it("rejects endpoint with query string and no path (host?q=1)", () => {
		// Before the fix: `host?q=1` → URL becomes `https://host/v1`
		// (query silently dropped, no error thrown)
		// After the fix: throws immediately with a clear message
		expect(() => new EndpointTemplate({ endpoint: "host?q=1" })).toThrow(
			/query string or hash fragment/,
		);
	});

	it("rejects endpoint with hash fragment and no path (host#section)", () => {
		// Before the fix: `host#section` → URL becomes `https://host/v1`
		// (hash silently dropped)
		expect(() => new EndpointTemplate({ endpoint: "host#section" })).toThrow(
			/query string or hash fragment/,
		);
	});

	it("rejects endpoint with query and hash but no path", () => {
		expect(
			() => new EndpointTemplate({ endpoint: "host?q=1#section" }),
		).toThrow(/query string or hash fragment/);
	});

	it("rejects scheme + host + query without path", () => {
		// `https://host?token=secret` has no path after authority,
		// so hasExplicitPath would have returned false
		expect(
			() => new EndpointTemplate({ endpoint: "https://host?token=secret" }),
		).toThrow(/query string or hash fragment/);
	});

	it("rejects host:port + query without path", () => {
		expect(
			() => new EndpointTemplate({ endpoint: "host:8080?key=val" }),
		).toThrow(/query string or hash fragment/);
	});

	it("still allows plain host (no query/hash) and defaults to /v1", () => {
		const t = new EndpointTemplate({ endpoint: "host" });
		expect(t.baseUrl()).toBe("https://host/v1");
		expect(t.explicitPathProvided).toBe(false);
	});

	it("still allows host with explicit path and no query/hash", () => {
		const t = new EndpointTemplate({ endpoint: "host/custom" });
		expect(t.baseUrl()).toBe("https://host/custom");
		expect(t.explicitPathProvided).toBe(true);
	});
});
