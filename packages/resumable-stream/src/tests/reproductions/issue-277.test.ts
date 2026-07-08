import { describe, expect, it } from "vitest";
import { HttpError } from "../../client-utils.js";
import { createConnection } from "../../tanstack-ai/client.js";

/**
 * Issue #277: with `reconnectBackoffMs` configured, subscribeChunks retried
 * forever on permanent HTTP errors (401/403/404) instead of surfacing them,
 * unlike subscribeSse. The fix throws when isPermanentError(err) is true.
 */

function countingFetch(response: () => Response): {
	fetch: typeof fetch;
	calls: () => number;
} {
	let calls = 0;
	const fakeFetch: typeof fetch = async () => {
		calls += 1;
		return response();
	};
	return { fetch: fakeFetch, calls: () => calls };
}

async function drainError(iterable: AsyncIterable<unknown>): Promise<unknown> {
	try {
		for await (const _ of iterable) {
		}
		return undefined;
	} catch (err) {
		return err;
	}
}

describe("Issue #277: subscribe() fails fast on permanent HTTP errors", () => {
	it("throws HttpError on 401 with reconnect enabled, after a single attempt", async () => {
		const { fetch, calls } = countingFetch(
			() => new Response("unauthorized", { status: 401 }),
		);
		const connection = createConnection({
			sendUrl: "/api/chat",
			subscribeUrl: "/api/chat/stream",
			fetch,
			reconnectBackoffMs: [0, 0],
		});

		const err = await drainError(connection.subscribe());
		expect(err).toBeInstanceOf(HttpError);
		expect((err as HttpError).status).toBe(401);
		expect(calls()).toBe(1);
	});

	it("still reconnects on transient failures (e.g. 500)", async () => {
		let attempts = 0;
		const fakeFetch: typeof fetch = async () => {
			attempts += 1;
			if (attempts === 1) return new Response("oops", { status: 500 });
			return new Response(null, { status: 204 });
		};
		const connection = createConnection({
			sendUrl: "/api/chat",
			subscribeUrl: "/api/chat/stream",
			fetch: fakeFetch,
			reconnectBackoffMs: [0],
		});

		const chunks: unknown[] = [];
		for await (const chunk of connection.subscribe()) chunks.push(chunk);

		expect(attempts).toBe(2);
		// The 204 after reconnect yields the synthetic terminal chunk.
		expect(chunks).toHaveLength(1);
	});

	it("throws on 401 immediately when reconnect is disabled (unchanged)", async () => {
		const { fetch, calls } = countingFetch(
			() => new Response("unauthorized", { status: 401 }),
		);
		const connection = createConnection({
			sendUrl: "/api/chat",
			subscribeUrl: "/api/chat/stream",
			fetch,
		});

		const err = await drainError(connection.subscribe());
		expect(err).toBeInstanceOf(HttpError);
		expect(calls()).toBe(1);
	});
});
