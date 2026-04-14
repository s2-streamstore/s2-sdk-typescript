import { describe, expect, it } from "vitest";
import { EventStream } from "../../lib/event-stream.js";

/**
 * Issue #184: EventStream async iterator polyfill throws when return() is
 * called after iteration is already done.
 *
 * When the polyfill is active, next() releases the reader lock on done: true.
 * A subsequent return() or throw() calls reader.cancel() on a detached reader,
 * which throws ERR_INVALID_STATE. Native async iterators allow return() after
 * exhaustion and silently return { done: true }.
 *
 * The same bug exists in the s2s transport polyfill.
 */

/**
 * Build a minimal EventStream whose upstream yields the given SSE chunks
 * and then closes.
 */
function makeEventStream(chunks: string[]): EventStream<string> {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});

	return new EventStream<string>(body, (msg) => {
		if (msg.data === undefined) return { done: true };
		return { done: false, value: msg.data };
	});
}

describe("Issue #184: polyfill return() after done must not throw", () => {
	it("return() after exhaustion returns { done: true } without throwing", async () => {
		const stream = makeEventStream(["data: hello\n\n"]);

		// Force the polyfill path by grabbing the iterator directly.
		// We access the polyfill by calling [Symbol.asyncIterator]() which
		// may use the native path. To reliably test the polyfill, we
		// temporarily remove the native implementation.
		const proto = ReadableStream.prototype as any;
		const original = proto[Symbol.asyncIterator];
		proto[Symbol.asyncIterator] = undefined;
		try {
			const iter = stream[Symbol.asyncIterator]();

			// Consume the single item
			const first = await iter.next();
			expect(first).toEqual({ done: false, value: "hello" });

			// Exhaust the stream
			const second = await iter.next();
			expect(second).toEqual({ done: true, value: undefined });

			// BUG: Before the fix, this throws ERR_INVALID_STATE because
			// the reader lock was already released in next().
			const result = await iter.return!();
			expect(result).toEqual({ done: true, value: undefined });
		} finally {
			proto[Symbol.asyncIterator] = original;
		}
	});

	it("throw() after exhaustion returns { done: true } without throwing", async () => {
		const stream = makeEventStream(["data: world\n\n"]);

		const proto = ReadableStream.prototype as any;
		const original = proto[Symbol.asyncIterator];
		proto[Symbol.asyncIterator] = undefined;
		try {
			const iter = stream[Symbol.asyncIterator]();

			// Consume and exhaust
			await iter.next();
			await iter.next();

			// BUG: Before the fix, this also throws ERR_INVALID_STATE.
			const result = await iter.throw!(new Error("test"));
			expect(result).toEqual({ done: true, value: undefined });
		} finally {
			proto[Symbol.asyncIterator] = original;
		}
	});

	it("return() before exhaustion cancels cleanly", async () => {
		const stream = makeEventStream(["data: a\n\ndata: b\n\n"]);

		const proto = ReadableStream.prototype as any;
		const original = proto[Symbol.asyncIterator];
		proto[Symbol.asyncIterator] = undefined;
		try {
			const iter = stream[Symbol.asyncIterator]();

			// Read one item but don't exhaust
			const first = await iter.next();
			expect(first).toEqual({ done: false, value: "a" });

			// Early return should work fine (reader still attached)
			const result = await iter.return!();
			expect(result).toEqual({ done: true, value: undefined });
		} finally {
			proto[Symbol.asyncIterator] = original;
		}
	});
});
