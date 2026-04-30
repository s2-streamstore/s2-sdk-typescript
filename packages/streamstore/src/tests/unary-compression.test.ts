import * as zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, createConfig } from "../generated/client/index.js";
import { installUnaryCompression } from "../lib/unary-compression.js";

const hasZstd =
	typeof (zlib as unknown as { zstdCompressSync?: unknown })
		.zstdCompressSync === "function";

describe("unary compression interceptor", () => {
	let capturedRequest: Request | undefined;

	beforeEach(() => {
		capturedRequest = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const fakeFetch = (responseBody: BodyInit, headers?: HeadersInit) => {
		return vi.fn(async (input: Request | URL | string) => {
			capturedRequest =
				input instanceof Request ? input : new Request(input.toString());
			return new Response(responseBody, { status: 200, headers });
		}) as unknown as typeof fetch;
	};

	it("compresses request body with gzip and sets Content-Encoding", async () => {
		const fetch = fakeFetch(JSON.stringify({ ok: true }), {
			"content-type": "application/json",
		});
		const client = createClient(
			createConfig({ baseUrl: "https://x.invalid", fetch }),
		);
		installUnaryCompression(client, "gzip");

		const payload = "x".repeat(2048);
		await client.post({
			url: "/test",
			body: { payload },
			bodySerializer: (b) => JSON.stringify(b),
			headers: { "content-type": "application/json" },
		});

		expect(capturedRequest).toBeDefined();
		expect(capturedRequest!.headers.get("content-encoding")).toBe("gzip");
		expect(capturedRequest!.headers.get("accept-encoding")).toBeTruthy();

		const sentBytes = new Uint8Array(await capturedRequest!.arrayBuffer());
		const roundtrip = zlib.gunzipSync(sentBytes).toString("utf8");
		expect(JSON.parse(roundtrip)).toEqual({ payload });
	});

	it("decompresses gzip response body", async () => {
		const original = JSON.stringify({ hello: "world" });
		const compressed = zlib.gzipSync(Buffer.from(original));
		const fetch = fakeFetch(compressed, {
			"content-type": "application/json",
			"content-encoding": "gzip",
		});
		const client = createClient(
			createConfig({ baseUrl: "https://x.invalid", fetch }),
		);
		installUnaryCompression(client, "gzip");

		const result = await client.get({
			url: "/test",
			responseStyle: "data",
		});

		expect(result).toEqual({ hello: "world" });
	});

	it.skipIf(!hasZstd)("decompresses zstd response body", async () => {
		const z = zlib as unknown as {
			zstdCompressSync: (data: ArrayBufferView) => Buffer;
		};
		const original = JSON.stringify({ hello: "zstd" });
		const compressed = z.zstdCompressSync(Buffer.from(original));
		const fetch = fakeFetch(compressed, {
			"content-type": "application/json",
			"content-encoding": "zstd",
		});
		const client = createClient(
			createConfig({ baseUrl: "https://x.invalid", fetch }),
		);
		installUnaryCompression(client, "zstd");

		const result = await client.get({
			url: "/test",
			responseStyle: "data",
		});

		expect(result).toEqual({ hello: "zstd" });
	});

	it("does not install interceptor when compression is none", async () => {
		const fetch = fakeFetch(JSON.stringify({ ok: true }), {
			"content-type": "application/json",
		});
		const client = createClient(
			createConfig({ baseUrl: "https://x.invalid", fetch }),
		);
		installUnaryCompression(client, "none");

		await client.post({
			url: "/test",
			body: { hi: 1 },
			bodySerializer: (b) => JSON.stringify(b),
			headers: { "content-type": "application/json" },
		});

		expect(capturedRequest!.headers.get("content-encoding")).toBeNull();
		expect(capturedRequest!.headers.get("accept-encoding")).toBeNull();
	});
});
