import { afterEach, describe, expect, it, vi } from "vitest";
import { EndpointTemplate, S2Endpoints } from "../endpoints.js";
import { S2 } from "../s2.js";

describe("S2Endpoints", () => {
	it("defaults to a.s2.dev + b.s2.dev endpoints with inferred /v1", () => {
		const endpoints = new S2Endpoints();
		expect(endpoints.accountBaseUrl()).toBe("https://a.s2.dev/v1");
		expect(endpoints.basinBaseUrl("my-basin")).toBe(
			"https://my-basin.b.s2.dev/v1",
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

describe("S2 client endpoints", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("reads S2_ACCOUNT_ENDPOINT / S2_BASIN_ENDPOINT when endpoints are not given", () => {
		vi.stubEnv("S2_ACCOUNT_ENDPOINT", "http://localhost:8080");
		vi.stubEnv("S2_BASIN_ENDPOINT", "http://localhost:8080");
		const s2 = new S2({ accessToken: "token" });
		expect(s2.basin("my-basin").stream("s")).toBeDefined();
		expect((s2 as any).endpoints.accountBaseUrl()).toBe(
			"http://localhost:8080/v1",
		);
	});

	it("prefers explicit endpoints over the environment", () => {
		vi.stubEnv("S2_ACCOUNT_ENDPOINT", "http://localhost:8080");
		const s2 = new S2({
			accessToken: "token",
			endpoints: { account: "https://example.com" },
		});
		expect((s2 as any).endpoints.accountBaseUrl()).toBe(
			"https://example.com/v1",
		);
	});
});
