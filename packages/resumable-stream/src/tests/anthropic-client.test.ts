import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import { describe, expect, it } from "vitest";
import { messagesFromEvents } from "../anthropic/accumulator.js";
import { createChatClient } from "../anthropic/client.js";

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

function frameBytes(event: RawMessageStreamEvent, id: number): string {
	return `event: ${event.type}\nid: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
}

function sseResponse(events: RawMessageStreamEvent[]): Response {
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

describe("createChatClient", () => {
	it("uses history nextSeqNum as the next replay cursor", async () => {
		const { fetch, calls } = recordingFetch([
			Response.json({ messages: [], nextSeqNum: 42 }),
			new Response(null, { status: 204 }),
		]);
		const chat = createChatClient({
			sendUrl: "/send",
			subscribeUrl: "/stream",
			historyUrl: "/history",
			fetch,
		});

		const history = await chat.loadHistory();
		await chat.subscribe();

		expect(history.nextSeqNum).toBe(42);
		expect(calls[0]!.url).toBe("/history");
		expect(calls[1]!.url).toBe("/stream?from=42");
	});

	it("messagesFromEvents pipes a subscription into reconstructed Messages", async () => {
		const { fetch } = recordingFetch([
			sseResponse(textTurnEvents("msg_1", "hi")),
		]);
		const chat = createChatClient({
			sendUrl: "/send",
			subscribeUrl: "/stream",
			fetch,
		});

		const subscription = await chat.subscribe();
		const messages: Awaited<ReturnType<typeof chat.loadHistory>>["messages"] =
			[];
		for await (const message of messagesFromEvents(subscription.events)) {
			messages.push(message);
		}

		expect(messages).toHaveLength(1);
		expect(messages[0]?.id).toBe("msg_1");
		expect(messages[0]?.content[0]?.type).toBe("text");
		if (messages[0]?.content[0]?.type === "text") {
			expect(messages[0]?.content[0].text).toBe("hi");
		}
	});

	it("cancel aborts an active subscription reader", async () => {
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
		const chat = createChatClient({
			sendUrl: "/send",
			subscribeUrl: "/stream",
			fetch,
		});

		const subscription = await chat.subscribe();
		const iterator = subscription.events[Symbol.asyncIterator]();
		const first = await iterator.next();
		expect(first.value?.type).toBe("message_start");

		subscription.cancel();
		const didCancel = await Promise.race([
			cancelled.then(() => true),
			sleep(100).then(() => false),
		]);
		await iterator.return?.();

		expect(didCancel).toBe(true);
	});

	it("auto-reconnects with ?from=<cursor> when the body drops mid-turn", async () => {
		const events = textTurnEvents("msg_resume", "resumed");
		// First response: partial — message_start, content_block_start, one text_delta, then EOF.
		const partial = truncatedSseResponse(events.slice(0, 3), 1);
		// Second response: the rest, with ids continuing from 4.
		const rest = truncatedSseResponse(events.slice(3), 4);
		const { fetch, calls } = recordingFetch([partial, rest]);

		const chat = createChatClient({
			sendUrl: "/send",
			subscribeUrl: "/stream",
			fetch,
			reconnectBackoffMs: [0],
		});

		const sub = await chat.subscribe();
		const collected: typeof events = [];
		for await (const event of sub.events) {
			collected.push(event as RawMessageStreamEvent);
		}

		expect(collected).toHaveLength(events.length);
		expect(collected.at(-1)?.type).toBe("message_stop");

		// Reconnect must carry the latest cursor (id of the last frame in the
		// truncated response, which was 3) on the GET URL.
		expect(calls).toHaveLength(2);
		expect(calls[0]!.url).toBe("/stream");
		expect(calls[1]!.url).toBe("/stream?from=3");
	});

	it("stops reconnecting after a terminal message_stop", async () => {
		const events = textTurnEvents("msg_done", "ok");
		const { fetch, calls } = recordingFetch([sseResponse(events)]);
		const chat = createChatClient({
			sendUrl: "/send",
			subscribeUrl: "/stream",
			fetch,
			reconnectBackoffMs: [0],
		});

		const sub = await chat.subscribe();
		// Drain — should end naturally on message_stop without hitting reconnect.
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		for await (const _event of sub.events) {
			// no-op
		}
		expect(calls).toHaveLength(1);
	});

	it("reconnect respects an explicitly empty backoff schedule", async () => {
		const events = textTurnEvents("msg_no_retry", "partial");
		const partial = truncatedSseResponse(events.slice(0, 2), 1);
		const { fetch, calls } = recordingFetch([partial]);
		const chat = createChatClient({
			sendUrl: "/send",
			subscribeUrl: "/stream",
			fetch,
			reconnectBackoffMs: [],
		});

		const sub = await chat.subscribe();
		const collected: RawMessageStreamEvent[] = [];
		for await (const event of sub.events) {
			collected.push(event as RawMessageStreamEvent);
		}
		// Body ended without terminal, but reconnect is disabled — single fetch.
		expect(collected).toHaveLength(2);
		expect(calls).toHaveLength(1);
	});
});
