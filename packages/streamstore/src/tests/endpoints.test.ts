import { afterEach, describe, expect, it, vi } from "vitest";
import { S2Environment } from "../common.js";
import { S2Endpoints } from "../endpoints.js";
import { S2Error } from "../error.js";
import { S2 } from "../index.js";
import { cleanupAfterEach, serveHttp1, withinDeadline } from "./helpers.js";

describe("S2Endpoints (C1, C3)", () => {
	const cleanup = cleanupAfterEach();

	const savedEnv = {
		S2_ACCESS_TOKEN: process.env.S2_ACCESS_TOKEN,
		S2_ACCOUNT_ENDPOINT: process.env.S2_ACCOUNT_ENDPOINT,
		S2_BASIN_ENDPOINT: process.env.S2_BASIN_ENDPOINT,
	};

	afterEach(() => {
		for (const [key, val] of Object.entries(savedEnv)) {
			if (val === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = val;
			}
		}
	});

	it("resolves valid endpoint configurations and s2-basin header behavior", () => {
		const cases: Array<{
			name: string;
			init?: { account: string; basin: string };
			accountUrl: string;
			basinUrl: string;
			includeBasinHeader: boolean;
		}> = [
			{
				name: "defaults",
				accountUrl: "https://a.s2.dev/v1",
				basinUrl: "https://my-basin-1.b.s2.dev/v1",
				includeBasinHeader: false,
			},
			{
				name: "host and port without scheme",
				init: { account: "localhost:8080", basin: "localhost:8080" },
				accountUrl: "https://localhost:8080/v1",
				basinUrl: "https://localhost:8080/v1",
				includeBasinHeader: true,
			},
			{
				name: "http with trailing slash keeps /v1",
				init: {
					account: "http://localhost:8080/",
					basin: "http://localhost:8080/",
				},
				accountUrl: "http://localhost:8080/v1",
				basinUrl: "http://localhost:8080/v1",
				includeBasinHeader: true,
			},
			{
				name: "bracketed IPv6",
				init: { account: "[::1]:8080", basin: "[::1]:8080" },
				accountUrl: "https://[::1]:8080/v1",
				basinUrl: "https://[::1]:8080/v1",
				includeBasinHeader: true,
			},
			{
				name: "one endpoint serving both",
				init: { account: "aws.s2.dev", basin: "aws.s2.dev" },
				accountUrl: "https://aws.s2.dev/v1",
				basinUrl: "https://aws.s2.dev/v1",
				includeBasinHeader: true,
			},
			{
				name: "{basin}. placeholder suppresses s2-basin header",
				init: {
					account: "https://a.example.com",
					basin: "https://{basin}.b.example.com",
				},
				accountUrl: "https://a.example.com/v1",
				basinUrl: "https://my-basin-1.b.example.com/v1",
				includeBasinHeader: false,
			},
		];

		for (const c of cases) {
			const endpoints = new S2Endpoints(c.init);
			expect(endpoints.accountBaseUrl(), c.name).toBe(c.accountUrl);
			expect(endpoints.basinBaseUrl("my-basin-1"), c.name).toBe(c.basinUrl);
			expect(endpoints.includeBasinHeader, c.name).toBe(c.includeBasinHeader);
		}
	});

	it("rejects invalid endpoints with SDK S2Error", () => {
		const invalid: Array<[string, unknown]> = [
			["account endpoint alone", { account: "https://a.example.com" }],
			["basin endpoint alone", { basin: "https://{basin}.b.example.com" }],
			[
				"path",
				{ account: "https://example.com/v1", basin: "https://example.com" },
			],
			[
				"placeholder in path",
				{ account: "example.com", basin: "example.com/{basin}" },
			],
			[
				"query",
				{ account: "https://example.com?x=1", basin: "https://example.com" },
			],
			[
				"fragment",
				{ account: "https://example.com#x", basin: "https://example.com" },
			],
			[
				"user info",
				{
					account: "https://user@example.com",
					basin: "https://example.com",
				},
			],
			[
				"unsupported scheme",
				{ account: "ftp://example.com", basin: "ftp://example.com" },
			],
			[
				"mixed schemes",
				{ account: "http://example.com", basin: "https://example.com" },
			],
			[
				"placeholder on account endpoint",
				{
					account: "https://{basin}.a.example.com",
					basin: "https://{basin}.b.example.com",
				},
			],
			[
				"placeholder with IPv4",
				{ account: "127.0.0.1", basin: "{basin}.127.0.0.1" },
			],
			[
				"placeholder with trailing-dot IPv4",
				{ account: "127.0.0.1", basin: "{basin}.127.0.0.1." },
			],
			["invalid IPv4", { account: "127.0.0.999", basin: "127.0.0.999" }],
			[
				"placeholder with bracketed IPv6",
				{ account: "[::1]", basin: "{basin}.[::1]" },
			],
			["malformed bracketed IPv6", { account: "[::1::1]", basin: "[::1::1]" }],
			[
				"placeholder with malformed IPv6",
				{ account: "example.com", basin: "{basin}.[::1::1]" },
			],
			[
				"placeholder without dot",
				{ account: "example.com", basin: "{basin}example.com" },
			],
			["bare IPv6", { account: "::1", basin: "::1" }],
			[
				"percent-encoded host",
				{ account: "example%20.com", basin: "example.com" },
			],
			["empty DNS label", { account: "a..example.com", basin: "example.com" }],
			["bare 0x TLD", { account: "example.0x", basin: "example.0x" }],
			["bare 0X TLD", { account: "example.0X", basin: "example.0X" }],
			["port zero", { account: "example.com:0", basin: "example.com:0" }],
			[
				"port out of range",
				{ account: "example.com:99999", basin: "example.com:99999" },
			],
			["empty endpoints", { account: "", basin: "" }],
		];

		for (const [name, init] of invalid) {
			let error: unknown;
			try {
				new S2({
					accessToken: "token",
					endpoints: init as { account: string; basin: string },
				});
			} catch (e) {
				error = e;
			}
			expect(error, name).toBeInstanceOf(S2Error);
			expect((error as S2Error).origin, name).toBe("sdk");
		}

		// Errors for endpoints carrying credentials must not echo passwords or user info.
		for (const bad of [
			"https://alice:s3cr3t@example.com",
			"https://alice:s3cr3t@example.com/v1",
			"https://alice:s3cr3t@example.com?token=s3cr3t",
			"alice:s3cr3t@example.com/a://b",
			"example.com?token=s3cr3t&next=http://evil",
		]) {
			let error: unknown;
			try {
				new S2({
					accessToken: "token",
					endpoints: { account: bad, basin: "https://example.com" },
				});
			} catch (e) {
				error = e;
			}
			expect(error, bad).toBeInstanceOf(S2Error);
			expect((error as S2Error).message, bad).not.toContain("s3cr3t");
			expect((error as S2Error).message, bad).not.toContain("alice");
		}

		// Resolved basin hostname exceeding the 253-character DNS limit rejects with SDK S2Error.
		const longSuffix = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(50)}.com`;
		const longBasinEndpoints = new S2Endpoints({
			account: "https://example.com",
			basin: `https://{basin}.${longSuffix}`,
		});
		expect(() => longBasinEndpoints.basinBaseUrl("a".repeat(30))).toThrow(
			S2Error,
		);
	});

	it("validates S2Environment.parse() endpoint pairing and empty variables", () => {
		const setEnv = (env: Record<string, string | undefined>) => {
			for (const key of [
				"S2_ACCESS_TOKEN",
				"S2_ACCOUNT_ENDPOINT",
				"S2_BASIN_ENDPOINT",
			]) {
				const val = env[key];
				if (val === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = val;
				}
			}
		};

		// Single endpoint (or one set + one empty) rejects.
		for (const env of [
			{ S2_ACCESS_TOKEN: "token", S2_ACCOUNT_ENDPOINT: "localhost:8080" },
			{ S2_ACCESS_TOKEN: "token", S2_BASIN_ENDPOINT: "localhost:8080" },
			{
				S2_ACCESS_TOKEN: "token",
				S2_ACCOUNT_ENDPOINT: "localhost:8080",
				S2_BASIN_ENDPOINT: "",
			},
		]) {
			setEnv(env);
			expect(() => S2Environment.parse()).toThrow(S2Error);
		}

		// Empty endpoint variables are treated as unset (defaults apply).
		for (const env of [
			{ S2_ACCESS_TOKEN: "token" },
			{
				S2_ACCESS_TOKEN: "token",
				S2_ACCOUNT_ENDPOINT: "",
				S2_BASIN_ENDPOINT: "",
			},
			{ S2_ACCESS_TOKEN: "token", S2_ACCOUNT_ENDPOINT: "" },
		]) {
			setEnv(env);
			const parsed = S2Environment.parse();
			expect(parsed.endpoints).toBeUndefined();
			expect(() => new S2(parsed as { accessToken: string })).not.toThrow();
		}

		// Both endpoints set together work.
		setEnv({
			S2_ACCESS_TOKEN: "token",
			S2_ACCOUNT_ENDPOINT: "localhost:8080",
			S2_BASIN_ENDPOINT: "localhost:8080",
		});
		const parsed = S2Environment.parse();
		expect(parsed.endpoints).toBeInstanceOf(S2Endpoints);
		const endpoints = parsed.endpoints as S2Endpoints;
		expect(endpoints.accountBaseUrl()).toBe("https://localhost:8080/v1");
		expect(endpoints.basinBaseUrl("my-basin-1")).toBe(
			"https://localhost:8080/v1",
		);
		expect(endpoints.includeBasinHeader).toBe(true);

		// Missing or empty token fails client construction.
		for (const env of [
			{
				S2_ACCOUNT_ENDPOINT: "localhost:8080",
				S2_BASIN_ENDPOINT: "localhost:8080",
			},
			{ S2_ACCESS_TOKEN: "" },
		]) {
			setEnv(env);
			expect(
				() => new S2(S2Environment.parse() as { accessToken: string }),
			).toThrow(S2Error);
		}
	});

	it("sends s2-basin header on the wire only when basin endpoint lacks {basin}.", async () => {
		const seenHeaders: Array<string | string[] | undefined> = [];
		const server = await serveHttp1((req, res) => {
			seenHeaders.push(req.headers["s2-basin"]);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ streams: [], has_more: false }));
		});
		cleanup(server.close);

		const withoutPlaceholder = new S2({
			accessToken: "token",
			endpoints: { account: server.origin, basin: server.origin },
		});
		await withinDeadline(withoutPlaceholder.basin("my-basin-1").streams.list());
		expect(seenHeaders).toEqual(["my-basin-1"]);

		// Construct a client whose basin endpoint uses `{basin}.` and verify the
		// outgoing HTTP request omits `s2-basin` (stubbing fetch to avoid wildcard DNS).
		const port = new URL(server.origin).port;
		const withPlaceholder = new S2({
			accessToken: "token",
			endpoints: {
				account: `http://127.0.0.1:${port}`,
				basin: `http://{basin}.localhost:${port}`,
			},
		});
		const observed: Array<{ url: string; basinHeader: string | null }> = [];
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input, init) => {
				const req = new Request(input, init);
				observed.push({
					url: req.url,
					basinHeader: req.headers.get("s2-basin"),
				});
				return new Response(JSON.stringify({ streams: [], has_more: false }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			});
		try {
			await withinDeadline(withPlaceholder.basin("my-basin-1").streams.list());
		} finally {
			fetchSpy.mockRestore();
		}
		expect(observed).toEqual([
			{
				url: `http://my-basin-1.localhost:${port}/v1/streams`,
				basinHeader: null,
			},
		]);
	});
});
