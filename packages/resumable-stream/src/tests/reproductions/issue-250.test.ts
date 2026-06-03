import type { StreamChunk } from "@tanstack/ai";
import { describe, expect, it } from "vitest";
import { createConnection } from "../../tanstack-ai/client.js";

/**
 * Issue #250: TanStack AI chat streaming hangs when replay returns HTTP 204.
 *
 * `subscribeChunks` returned an empty `AsyncIterable` on a 204/no-body replay
 * response, so TanStack's `consumeSubscription` loop finished without ever
 * seeing a terminal chunk and `streamResponse()` hung on `processingComplete`.
 * The fix yields a synthetic `RUN_FINISHED` so the subscription terminates.
 */

async function drain(
	iterable: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> {
	const out: StreamChunk[] = [];
	for await (const chunk of iterable) out.push(chunk);
	return out;
}

describe("Issue #250: 204 replay yields a terminal chunk", () => {
	it("yields a synthetic RUN_FINISHED instead of an empty stream on 204", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response(null, { status: 204 });
		const connection = createConnection({
			sendUrl: "/api/chat",
			subscribeUrl: "/api/chat/stream",
			fetch,
		});

		const collected = await drain(connection.subscribe());

		expect(collected).toHaveLength(1);
		expect(collected[0]!.type).toBe("RUN_FINISHED");
	});

	it("also terminates when the response has a 200 status but no body", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response(null, { status: 200 });
		const connection = createConnection({
			sendUrl: "/api/chat",
			subscribeUrl: "/api/chat/stream",
			fetch,
		});

		const collected = await drain(connection.subscribe());

		expect(collected).toHaveLength(1);
		expect(collected[0]!.type).toBe("RUN_FINISHED");
	});
});
