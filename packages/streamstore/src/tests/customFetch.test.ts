import { describe, expect, it } from "vitest";
import { S2 } from "../s2.js";

const BASIN = "custom-fetch-basin";
const STREAM = "custom-fetch-stream";

type RecordedRequest = { url: string; headers: Headers };

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function sseResponse(events: string): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(events));
			},
		}),
		{
			status: 200,
			headers: { "content-type": "text/event-stream" },
		},
	);
}

function makeFetch(respond: (req: Request) => Response) {
	const requests: RecordedRequest[] = [];
	const fetchImpl = (async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const request = new Request(input, init);
		requests.push({ url: request.url, headers: request.headers });
		return respond(request);
	}) as typeof globalThis.fetch;
	return { fetchImpl, requests };
}

describe("custom fetch injection", () => {
	it("uses the injected fetch for account-level operations", async () => {
		const { fetchImpl, requests } = makeFetch(() =>
			jsonResponse({ basins: [], has_more: false }),
		);
		const s2 = new S2({ accessToken: "test-token", fetch: fetchImpl });

		const result = await s2.basins.list();

		expect(result.basins).toEqual([]);
		expect(requests).toHaveLength(1);
		expect(requests[0]!.url).toContain("a.s2.dev");
		expect(requests[0]!.headers.get("authorization")).toBe("Bearer test-token");
	});

	it("uses the injected fetch for unary stream reads", async () => {
		const { fetchImpl, requests } = makeFetch(() =>
			jsonResponse({
				records: [{ seq_num: 0, timestamp: 1000, body: "hello" }],
				tail: { seq_num: 1, timestamp: 1000 },
			}),
		);
		const s2 = new S2({ accessToken: "test-token", fetch: fetchImpl });

		const batch = await s2.basin(BASIN).stream(STREAM).read();

		expect(batch.records).toHaveLength(1);
		expect(batch.records[0]!.body).toBe("hello");
		expect(requests).toHaveLength(1);
		expect(requests[0]!.url).toContain(`${BASIN}.b.s2.dev`);
		expect(requests[0]!.url).toContain(STREAM);
	});

	it("uses the injected fetch for SSE read sessions", async () => {
		const events =
			`event: batch\n` +
			`data: ${JSON.stringify({
				records: [{ seq_num: 0, timestamp: 1000, body: "hello" }],
				tail: { seq_num: 1, timestamp: 1000 },
			})}\n\n`;
		const { fetchImpl, requests } = makeFetch(() => sseResponse(events));
		const s2 = new S2({ accessToken: "test-token", fetch: fetchImpl });

		const session = await s2
			.basin(BASIN)
			.stream(STREAM, { forceTransport: "fetch" })
			.readSession();
		const reader = session.getReader();
		try {
			const first = await reader.read();
			expect(first.done).toBe(false);
			expect(first.value?.body).toBe("hello");
		} finally {
			await reader.cancel();
		}

		expect(requests.length).toBeGreaterThanOrEqual(1);
		expect(requests[0]!.url).toContain(STREAM);
		expect(requests[0]!.headers.get("authorization")).toBe("Bearer test-token");
	});
});
