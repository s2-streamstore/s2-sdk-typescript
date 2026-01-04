import { describe, expect, it } from "vitest";
import { EndpointTemplate, S2Endpoints } from "../endpoints.js";

describe("S2Endpoints", () => {
	it("defaults to aws endpoints with inferred /v1", () => {
		const endpoints = new S2Endpoints();
		expect(endpoints.accountBaseUrl()).toBe("https://aws.s2.dev/v1");
		expect(endpoints.basinBaseUrl("my-basin")).toBe(
			"https://my-basin.b.aws.s2.dev/v1",
		);
		expect(endpoints.includeBasinHeader).toBe(false);
	});

	it("infers https scheme when missing", () => {
		const endpoints = new S2Endpoints({ account: "example.com:8443" });
		expect(endpoints.accountBaseUrl()).toBe("https://example.com:8443/v1");
	});

	it("uses explicit path when provided (does not append /v1)", () => {
		const endpoints = new S2Endpoints({
			account: "https://example.com/test/here",
		});
		expect(endpoints.accountBaseUrl()).toBe("https://example.com/test/here");
	});

	it("treats a trailing slash as an explicit path", () => {
		const endpoints = new S2Endpoints({ account: "https://example.com/" });
		expect(endpoints.accountBaseUrl()).toBe("https://example.com/");
	});

	it("supports {basin} placeholder in hostname", () => {
		const endpoints = new S2Endpoints({
			basin: "https://{basin}.cell.example.com:8443",
		});
		expect(endpoints.basinBaseUrl("demo-basin")).toBe(
			"https://demo-basin.cell.example.com:8443/v1",
		);
		expect(endpoints.includeBasinHeader).toBe(true);
	});

	it("supports {basin} placeholder in path with encoding", () => {
		const endpoints = new S2Endpoints({
			basin: "https://cell.example.com/api/{basin}/v2",
		});
		expect(endpoints.basinBaseUrl("a/b")).toBe(
			"https://cell.example.com/api/a%2Fb/v2",
		);
	});
});

describe("EndpointTemplate", () => {
	it("rejects empty endpoints", () => {
		expect(() => new EndpointTemplate({ endpoint: "   " })).toThrow(
			"Endpoint cannot be empty",
		);
	});

	it("defaults to /v1 only when no path delimiter exists", () => {
		const a = new EndpointTemplate({ endpoint: "example.com" });
		expect(a.baseUrl()).toBe("https://example.com/v1");

		const b = new EndpointTemplate({ endpoint: "example.com/" });
		expect(b.baseUrl()).toBe("https://example.com/");
	});
});
