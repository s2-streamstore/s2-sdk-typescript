import { describe, expect, it } from "vitest";
import { subscribe } from "../../anthropic/client.js";
import { HttpError, isPermanentError } from "../../client-utils.js";

/**
 * Issue #232: the SSE reconnect loop retried on every fetch error, so a
 * permanent HTTP failure (401/403/404) was retried indefinitely instead of
 * being surfaced. The fix attaches the status to the thrown error and fails
 * fast for permanent errors (4xx other than 408/429).
 */

interface CapturedRequest {
	url: string;
}

function recordingFetch(responses: Response[]): {
	fetch: typeof fetch;
	calls: CapturedRequest[];
} {
	const calls: CapturedRequest[] = [];
	const queue = [...responses];
	const fakeFetch: typeof fetch = async (input) => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push({ url });
		const next = queue.shift();
		if (!next) throw new Error(`fetch called more times than expected: ${url}`);
		return next;
	};
	return { fetch: fakeFetch, calls };
}

/** SSE body emitting one `data` frame per id, then ending (no terminal event). */
function sse(ids: number[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const id of ids) {
				controller.enqueue(
					encoder.encode(`id: ${id}\ndata: ${JSON.stringify({ id })}\n\n`),
				);
			}
			controller.close();
		},
	});
	return new Response(body, {
		headers: { "Content-Type": "text/event-stream" },
	});
}

async function drain(iter: AsyncIterable<unknown>): Promise<unknown[]> {
	const out: unknown[] = [];
	for await (const v of iter) out.push(v);
	return out;
}

describe("Issue #232: SSE reconnect fails fast on permanent HTTP errors", () => {
	it("throws (does not retry forever) on a 401 after a dropped body", async () => {
		// Valid stream once (drops mid-turn -> triggers reconnect), then 401 forever.
		const { fetch, calls } = recordingFetch([
			sse([1, 2]),
			new Response(null, { status: 401, statusText: "Unauthorized" }),
			new Response(null, { status: 401, statusText: "Unauthorized" }),
		]);

		await expect(
			drain(subscribe({ url: "/stream", fetch, reconnectBackoffMs: [0] })),
		).rejects.toMatchObject({ status: 401 });

		// One stream + one failed reconnect = 2 calls. No indefinite looping.
		expect(calls).toHaveLength(2);
	});

	it("fails fast on the initial request when it returns 403", async () => {
		const { fetch, calls } = recordingFetch([
			new Response(null, { status: 403, statusText: "Forbidden" }),
		]);

		await expect(
			drain(subscribe({ url: "/stream", fetch, reconnectBackoffMs: [0] })),
		).rejects.toMatchObject({ status: 403 });
		expect(calls).toHaveLength(1);
	});

	it("still retries transient errors (429) and resumes", async () => {
		const { fetch, calls } = recordingFetch([
			sse([1, 2]),
			new Response(null, { status: 429, statusText: "Too Many Requests" }),
			sse([3, 4]),
			new Response(null, { status: 204 }),
		]);

		const collected = await drain(
			subscribe({ url: "/stream", fetch, reconnectBackoffMs: [0] }),
		);

		expect(collected).toHaveLength(4);
		expect(calls).toHaveLength(4);
		// Reconnect after the 429 resumes from the last seen id (2).
		expect(calls[2]!.url).toBe("/stream?from=2");
	});

	it("classifies statuses correctly", () => {
		expect(isPermanentError(new HttpError(401, "Unauthorized"))).toBe(true);
		expect(isPermanentError(new HttpError(404, "Not Found"))).toBe(true);
		expect(isPermanentError(new HttpError(408, "Request Timeout"))).toBe(false);
		expect(isPermanentError(new HttpError(429, "Too Many Requests"))).toBe(
			false,
		);
		expect(isPermanentError(new HttpError(503, "Service Unavailable"))).toBe(
			false,
		);
		// Network errors (no status) are transient.
		expect(isPermanentError(new Error("network down"))).toBe(false);
	});
});
