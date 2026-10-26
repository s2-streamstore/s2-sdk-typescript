import { describe, expect, it } from "vitest";
import { S2Error } from "../error.js";
import { createClient, createConfig } from "../generated/client/index.js";
import { FetchReadSession } from "../lib/stream/transport/fetch/index.js";

/**
 * The fetch read transport must label server-originated read errors with
 * `origin: "server"`, so callers can distinguish server faults from SDK bugs.
 * `S2Error` defaults `origin` to `"sdk"`, so each server-error construction site
 * must set it explicitly. These tests pin the three such sites in the fetch
 * read path (non-416 HTTP error, its statusText fallback, and the SSE
 * `event: error` frame) plus the contrasting local-protocol error, which must
 * stay `"sdk"`.
 */

function sseBody(events: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(event));
			}
			controller.close();
		},
	});
}

function mockClient(fetchImpl: () => Promise<Response>) {
	return createClient(
		createConfig({
			auth: "ignored",
			baseUrl: "http://example.test/v1",
			fetch: fetchImpl as unknown as typeof fetch,
		}),
	);
}

describe("FetchReadSession error origin", () => {
	it("labels a non-416 HTTP server error as origin=server", async () => {
		const client = mockClient(
			async () =>
				new Response(JSON.stringify({ message: "boom", code: "internal" }), {
					status: 500,
					statusText: "Internal Server Error",
					headers: { "content-type": "application/json" },
				}),
		);

		await expect(
			FetchReadSession.create(client, "test-stream"),
		).rejects.toMatchObject({
			name: "S2Error",
			message: "boom",
			code: "internal",
			status: 500,
			origin: "server",
		});
	});

	it("labels the statusText-fallback HTTP server error as origin=server", async () => {
		// Non-JSON body: the generated client sets response.error to the raw
		// string, so the structured-message branch is skipped and the
		// statusText fallback fires.
		const client = mockClient(
			async () =>
				new Response("Upstream is down", {
					status: 502,
					statusText: "Bad Gateway",
					headers: { "content-type": "text/plain" },
				}),
		);

		await expect(
			FetchReadSession.create(client, "test-stream"),
		).rejects.toMatchObject({
			name: "S2Error",
			message: "Bad Gateway",
			status: 502,
			origin: "server",
		});
	});

	it("labels an SSE error event as origin=server", async () => {
		const session = FetchReadSession._createForTesting(
			sseBody(["event: error\ndata: server blew up\n\n"]),
			"string",
		);
		const reader = session.getReader();

		const first = await reader.read();
		expect(first.done).toBe(false);
		const result = first.value;
		expect(result).toBeDefined();
		expect(result!.ok).toBe(false);
		if (!result!.ok) {
			const error = result!.error as S2Error;
			expect(error).toBeInstanceOf(S2Error);
			expect(error.message).toBe("server blew up");
			expect(error.status).toBe(503);
			expect(error.origin).toBe("server");
		}

		await expect(reader.read()).resolves.toEqual({
			done: true,
			value: undefined,
		});
	});

	it("still labels a missing SSE response body as origin=sdk", async () => {
		// 200 OK with no body is a local protocol violation, not a server error:
		// the contrast that the `origin` field distinguishes. Must stay "sdk".
		const client = mockClient(async () => new Response(null, { status: 200 }));

		await expect(
			FetchReadSession.create(client, "test-stream"),
		).rejects.toMatchObject({
			name: "S2Error",
			message: "No body in SSE response",
			code: "INVALID_RESPONSE",
			status: 502,
			origin: "sdk",
		});
	});
});
