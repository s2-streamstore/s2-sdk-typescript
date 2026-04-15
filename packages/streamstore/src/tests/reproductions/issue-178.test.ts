import { describe, expect, it } from "vitest";
import { EndpointTemplate } from "../../endpoints.js";

/**
 * Issue #178: Endpoints with query/hash generate malformed request URLs.
 *
 * When an endpoint includes a query string (e.g., `https://host/api?token=secret`)
 * or a hash fragment, `EndpointTemplate` stores the query/hash inside `pathTemplate`.
 * Downstream URL construction concatenates `baseUrl + "/streams"`, which appends the
 * API path after `?` or `#`, producing malformed URLs like:
 *   `https://host/api?token=secret/streams`
 *
 * The fix rejects endpoints that include query strings or hash fragments, since they
 * cannot be correctly preserved through the URL construction pipeline.
 */
describe("Issue #178: endpoints with query/hash should be rejected", () => {
	it("rejects endpoint with query string", () => {
		expect(
			() => new EndpointTemplate({ endpoint: "https://host/api?token=secret" }),
		).toThrow(/query string or hash fragment/);
	});

	it("rejects endpoint with hash fragment", () => {
		expect(
			() => new EndpointTemplate({ endpoint: "https://host/api#section" }),
		).toThrow(/query string or hash fragment/);
	});

	it("rejects endpoint with both query and hash", () => {
		expect(
			() =>
				new EndpointTemplate({
					endpoint: "https://host/api?token=secret#section",
				}),
		).toThrow(/query string or hash fragment/);
	});

	it("rejects endpoint with query but no explicit path", () => {
		expect(
			() => new EndpointTemplate({ endpoint: "https://host?token=secret" }),
		).toThrow(/query string or hash fragment/);
	});

	it("rejects endpoint with hash but no explicit path", () => {
		expect(() => new EndpointTemplate({ endpoint: "host#section" })).toThrow(
			/query string or hash fragment/,
		);
	});

	it("allows normal endpoints without query/hash", () => {
		// These should all still work fine
		const a = new EndpointTemplate({ endpoint: "https://host/api" });
		expect(a.baseUrl()).toBe("https://host/api");

		const b = new EndpointTemplate({ endpoint: "host:8080" });
		expect(b.baseUrl()).toBe("https://host:8080/v1");

		const c = new EndpointTemplate({ endpoint: "https://host/" });
		expect(c.baseUrl()).toBe("https://host/");
	});
});
