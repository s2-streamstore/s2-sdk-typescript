import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import { describe, expect, it } from "vitest";
import { subscribe } from "../anthropic/client.js";

const baseUsage = {
	input_tokens: 5,
	output_tokens: 1,
	cache_creation_input_tokens: 0,
	cache_read_input_tokens: 0,
};

interface CapturedRequest {
	url: string;
	init: RequestInit;
}

function recordingFetch(responses: Response[]): {
	fetch: typeof fetch;
	calls: CapturedRequest[];
} {
	const calls: CapturedRequest[] = [];
	const queue = [...responses];
	const fakeFetch: typeof fetch = async (input, init = {}) => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push({ url, init });
		const next = queue.shift();
		if (!next) throw new Error(`fetch called more times than expected: ${url}`);
		return next;
	};
	return { fetch: fakeFetch, calls };
}

function textTurnEvents(id: string, text: string): RawMessageStreamEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id,
				type: "message",
				role: "assistant",
				model: "claude-haiku-4-5-20251001",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				container: null,
				stop_details: null,
				usage: baseUsage,
			},
		} as unknown as RawMessageStreamEvent,
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		} as unknown as RawMessageStreamEvent,
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		} as unknown as RawMessageStreamEvent,
		{ type: "content_block_stop", index: 0 } as RawMessageStreamEvent,
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 5 },
		} as unknown as RawMessageStreamEvent,
		{ type: "message_stop" } as RawMessageStreamEvent,
	];
}

function frameBytes(event: { type: string }, id: number): string {
	return `event: ${event.type}\nid: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
}

function sseResponse(events: { type: string }[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let index = 0; index < events.length; index += 1) {
				controller.enqueue(
					encoder.encode(frameBytes(events[index]!, index + 1)),
				);
			}
			controller.close();
		},
	});
	return new Response(body, {
		headers: { "Content-Type": "text/event-stream" },
	});
}

/** Response whose body emits the listed events then ends abruptly (no terminal). */
function truncatedSseResponse(
	events: RawMessageStreamEvent[],
	startId = 1,
): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let index = 0; index < events.length; index += 1) {
				controller.enqueue(
					encoder.encode(frameBytes(events[index]!, startId + index)),
				);
			}
			controller.close();
		},
	});
	return new Response(body, {
		headers: { "Content-Type": "text/event-stream" },
	});
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("subscribe", () => {
	it("yields parsed events from an SSE response", async () => {
		const events = textTurnEvents("msg_1", "hi");
		const { fetch, calls } = recordingFetch([sseResponse(events)]);

		const collected: RawMessageStreamEvent[] = [];
		for await (const event of subscribe({
			url: "/stream",
			fetch,
			reconnectBackoffMs: [],
		})) {
			collected.push(event as RawMessageStreamEvent);
		}

		expect(collected).toHaveLength(events.length);
		expect(collected.at(-1)?.type).toBe("message_stop");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("/stream");
	});

	it("drains multiple turns from the same body", async () => {
		const { fetch } = recordingFetch([
			sseResponse([
				...textTurnEvents("msg_1", "done"),
				...textTurnEvents("msg_2", "next"),
			]),
		]);

		const collected: RawMessageStreamEvent[] = [];
		for await (const event of subscribe({
			url: "/stream",
			fetch,
			reconnectBackoffMs: [],
		})) {
			collected.push(event as RawMessageStreamEvent);
		}

		const stopCount = collected.filter((e) => e.type === "message_stop").length;
		expect(stopCount).toBe(2);
	});

	it("auto-reconnects with ?from=<cursor> when the body drops mid-turn", async () => {
		const events = textTurnEvents("msg_resume", "resumed");
		const partial = truncatedSseResponse(events.slice(0, 3), 1);
		const rest = truncatedSseResponse(events.slice(3), 4);
		const done = new Response(null, { status: 204 });
		const { fetch, calls } = recordingFetch([partial, rest, done]);

		const collected: RawMessageStreamEvent[] = [];
		for await (const event of subscribe({
			url: "/stream",
			fetch,
			reconnectBackoffMs: [0],
		})) {
			collected.push(event as RawMessageStreamEvent);
		}

		expect(collected).toHaveLength(events.length);
		expect(collected.at(-1)?.type).toBe("message_stop");

		expect(calls).toHaveLength(3);
		expect(calls[0]!.url).toBe("/stream");
		// Last id seen in partial was 3.
		expect(calls[1]!.url).toBe("/stream?from=3");
		// Last id seen in rest was 6 (partial ids 1..3, rest ids 4..6).
		expect(calls[2]!.url).toBe("/stream?from=6");
	});

	it("stops when reconnect returns HTTP 204", async () => {
		const events = textTurnEvents("msg_done", "ok");
		const done = new Response(null, { status: 204 });
		const { fetch, calls } = recordingFetch([sseResponse(events), done]);

		const collected: RawMessageStreamEvent[] = [];
		for await (const event of subscribe({
			url: "/stream",
			fetch,
			reconnectBackoffMs: [0],
		})) {
			collected.push(event as RawMessageStreamEvent);
		}

		expect(collected).toHaveLength(events.length);
		expect(calls).toHaveLength(2);
	});

	it("respects an explicitly empty backoff schedule", async () => {
		const events = textTurnEvents("msg_no_retry", "partial");
		const partial = truncatedSseResponse(events.slice(0, 2), 1);
		const { fetch, calls } = recordingFetch([partial]);

		const collected: RawMessageStreamEvent[] = [];
		for await (const event of subscribe({
			url: "/stream",
			fetch,
			reconnectBackoffMs: [],
		})) {
			collected.push(event as RawMessageStreamEvent);
		}

		expect(collected).toHaveLength(2);
		expect(calls).toHaveLength(1);
	});

	it("aborts via signal", async () => {
		const encoder = new TextEncoder();
		let resolveCancelled: () => void = () => {};
		const cancelled = new Promise<void>((resolve) => {
			resolveCancelled = resolve;
		});
		const firstEvent = textTurnEvents("msg_cancel", "partial")[0]!;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						`event: ${firstEvent.type}\nid: 1\ndata: ${JSON.stringify(firstEvent)}\n\n`,
					),
				);
			},
			cancel() {
				resolveCancelled();
			},
		});
		const { fetch } = recordingFetch([
			new Response(body, {
				headers: { "Content-Type": "text/event-stream" },
			}),
		]);

		const ac = new AbortController();
		const iter = subscribe({ url: "/stream", fetch, signal: ac.signal })[
			Symbol.asyncIterator
		]();
		const first = await iter.next();
		expect((first.value as RawMessageStreamEvent | undefined)?.type).toBe(
			"message_start",
		);

		ac.abort();
		const didCancel = await Promise.race([
			cancelled.then(() => true),
			sleep(100).then(() => false),
		]);
		await iter.return?.();
		expect(didCancel).toBe(true);
	});
});
