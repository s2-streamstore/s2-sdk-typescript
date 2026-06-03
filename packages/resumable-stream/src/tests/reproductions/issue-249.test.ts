import { describe, expect, it } from "vitest";
import { subscribeSse } from "../../client-utils.js";

/**
 * Issue #249: SSE client subscriptions crash on mid-stream errors instead of
 * reconnecting.
 *
 * `subscribeSse` wrapped only the `fetchOk` call in try/catch, not the
 * `for await` over `pipeSseFrames`. When the response body errored
 * mid-iteration, the throw escaped the function before it could reach the
 * reconnection logic. The fix wraps the loop: it reconnects from the last
 * cursor when backoff is configured, and rethrows when it is disabled.
 */

function sseFrame(id: number, data: unknown): string {
	return `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A body that yields `prefix`, then errors mid-stream. */
function erroringBody(prefix: string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let sent = false;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (!sent) {
				sent = true;
				controller.enqueue(encoder.encode(prefix));
				return;
			}
			controller.error(new Error("Network failure during pull"));
		},
	});
}

function sseResponse(body: BodyInit | null, status = 200): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": "text/event-stream" },
	});
}

async function collect<T>(
	iterable: AsyncIterable<T>,
	limit: number,
): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iterable) {
		out.push(item);
		if (out.length >= limit) break;
	}
	return out;
}

describe("Issue #249: subscribeSse recovers from mid-stream errors", () => {
	it("reconnects from the last cursor when the stream errors mid-iteration", async () => {
		const responses = [
			sseResponse(erroringBody(sseFrame(1, { n: 1 }))),
			sseResponse(sseFrame(2, { n: 2 })),
		];
		const urls: string[] = [];
		const fetch: typeof globalThis.fetch = async (input) => {
			urls.push(typeof input === "string" ? input : input.toString());
			const next = responses.shift();
			if (!next) throw new Error("unexpected extra fetch");
			return next;
		};

		const got = await collect(
			subscribeSse<{ n: number }>({
				url: "/replay",
				fetch,
				reconnectBackoffMs: [0],
			}),
			2,
		);

		expect(got).toEqual([{ n: 1 }, { n: 2 }]);
		// Reconnect resumed from the cursor advanced by frame id 1.
		expect(urls[1]).toBe("/replay?from=1");
	});

	it("rethrows the mid-stream error when reconnect is disabled", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			sseResponse(erroringBody(sseFrame(1, { n: 1 })));

		const iter = subscribeSse<{ n: number }>({
			url: "/replay",
			fetch,
			reconnectBackoffMs: [],
		});

		await expect(collect(iter, 5)).rejects.toThrow(
			"Network failure during pull",
		);
	});
});
