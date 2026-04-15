import { describe, expect, it } from "vitest";
import { EventStream } from "../../lib/event-stream.js";

/**
 * Issue #161: EventStream ignores backpressure and buffers entire SSE response.
 *
 * The `pull()` method contains a `while(true)` loop that keeps reading from
 * the upstream source and enqueuing to downstream even when the downstream
 * consumer hasn't asked for more data. This means once pull() is first
 * invoked, it drains the entire upstream regardless of backpressure.
 *
 * The fix: check `downstream.desiredSize > 0` as the loop condition so
 * pull() returns when the downstream queue is full, letting the stream
 * infrastructure call pull() again when the consumer is ready.
 */

/**
 * Creates a controllable upstream that counts how many times it has been pulled.
 */
function createCountingUpstream(messageCount: number) {
	let pullCount = 0;
	const encoder = new TextEncoder();

	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			pullCount++;
			if (pullCount > messageCount) {
				controller.close();
				return;
			}
			const message = `data: message ${pullCount}\n\n`;
			controller.enqueue(encoder.encode(message));
		},
	});

	return {
		stream,
		get pullCount() {
			return pullCount;
		},
	};
}

describe("Issue #161: EventStream must respect backpressure", () => {
	it("does not pull from upstream when downstream has not requested more data", async () => {
		const upstream = createCountingUpstream(20);

		const eventStream = new EventStream<string>(upstream.stream, (msg) => {
			if (msg.data === undefined) return { done: false };
			return { done: false, value: msg.data };
		});

		const reader = eventStream.getReader();

		// Read exactly one message
		const first = await reader.read();
		expect(first.done).toBe(false);
		expect(first.value).toBe("message 1");

		// Give any pending microtasks/macrotasks a chance to run
		await new Promise((resolve) => setTimeout(resolve, 50));

		// The upstream should NOT have been pulled excessively.
		// With proper backpressure, pull() returns after satisfying demand.
		// The default HWM for ReadableStream is 1, so after enqueueing 1 item
		// and the consumer reading it, at most ~2-3 pulls are reasonable
		// (1 to fill the internal queue, 1 to satisfy the read, possibly 1 more).
		// Without the fix, all 20 messages would be pulled.
		expect(upstream.pullCount).toBeLessThanOrEqual(3);

		// Read the second message to verify the stream still works
		const second = await reader.read();
		expect(second.done).toBe(false);
		expect(second.value).toBe("message 2");

		await reader.cancel();
	});

	it("eventually delivers all messages when consumer reads them all", async () => {
		const totalMessages = 10;
		const upstream = createCountingUpstream(totalMessages);

		const eventStream = new EventStream<string>(upstream.stream, (msg) => {
			if (msg.data === undefined) return { done: false };
			return { done: false, value: msg.data };
		});

		const reader = eventStream.getReader();
		const received: string[] = [];

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			received.push(value);
		}

		expect(received).toHaveLength(totalMessages);
		for (let i = 0; i < totalMessages; i++) {
			expect(received[i]).toBe(`message ${i + 1}`);
		}
	});

	it("handles batch messages with backpressure", async () => {
		const encoder = new TextEncoder();
		let pulled = false;

		// Upstream sends a single batch message
		const upstream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!pulled) {
					pulled = true;
					const message = `data: [1,2,3]\n\n`;
					controller.enqueue(encoder.encode(message));
				} else {
					controller.close();
				}
			},
		});

		const eventStream = new EventStream<number>(upstream, (msg) => {
			if (msg.data === undefined) return { done: false };
			const arr = JSON.parse(msg.data) as number[];
			return { done: false, batch: true, value: arr };
		});

		const reader = eventStream.getReader();
		const results: number[] = [];

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			results.push(value);
		}

		expect(results).toEqual([1, 2, 3]);
	});
});
