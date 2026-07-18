import { describe, expect, it } from "vitest";
import { FetchReadSession } from "../lib/stream/transport/fetch/index.js";

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

describe("FetchReadSession", () => {
	it("reports caught-up state for batches and heartbeats", async () => {
		const session = FetchReadSession._createForTesting(
			sseBody([
				'event: batch\ndata: {"records":[{"seq_num":0,"timestamp":1,"body":"a"},{"seq_num":1,"timestamp":1,"body":"b"}],"tail":{"seq_num":2,"timestamp":1}}\n\n',
				'event: ping\ndata: {"timestamp":123,"tail":{"seq_num":2,"timestamp":1}}\n\n',
				'event: batch\ndata: {"records":[{"seq_num":2,"timestamp":1,"body":"c"}],"tail":{"seq_num":5,"timestamp":1}}\n\n',
				'event: batch\ndata: {"records":[],"tail":{"seq_num":5,"timestamp":1}}\n\n',
				'event: ping\ndata: {"timestamp":124}\n\n',
			]),
			"string",
		);

		const reader = session.getReader();
		const results = [];
		while (true) {
			const r = await reader.read();
			if (r.done) break;
			results.push(r.value);
		}

		expect(results).toMatchObject([
			{ ok: true, value: { seq_num: 0 } },
			{ ok: true, value: { seq_num: 1 }, caughtUp: { seq_num: 2 } },
			{ ok: true, caughtUp: { seq_num: 2 } },
			{ ok: true, value: { seq_num: 2 }, caughtUp: null },
			{ ok: true, caughtUp: { seq_num: 5 } },
			{ ok: true, caughtUp: { seq_num: 5 } },
		]);
		expect(results[0]).not.toHaveProperty("caughtUp");
		expect(session.nextReadPosition()).toMatchObject({ seq_num: 3 });
		expect(session.lastObservedTail()).toMatchObject({ seq_num: 5 });
	});

	it("converts raw browser body stream errors into transport error results", async () => {
		const body = new ReadableStream<Uint8Array>({
			pull() {
				throw new TypeError("network error");
			},
		});
		const session = FetchReadSession._createForTesting(body, "string");
		const reader = session.getReader();

		const first = await reader.read();
		expect(first.done).toBe(false);
		expect(first.value).toBeDefined();
		const result = first.value!;
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.status).toBe(502);
			expect(result.error.code).toBe("NETWORK_ERROR");
		}

		await expect(reader.read()).resolves.toEqual({
			done: true,
			value: undefined,
		});
	});
});
