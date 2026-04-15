import { describe, expect, it } from "vitest";

/**
 * Issue #166: Fetch transport async iterator polyfill leaks active fetch
 * requests on early termination.
 *
 * The manual [Symbol.asyncIterator] implementation in FetchReadSession calls
 * only reader.releaseLock() in return()/throw(), without first calling
 * reader.cancel(). This means breaking out of a `for await...of` loop leaves
 * the underlying fetch/SSE request active, leaking resources.
 *
 * The fix adds reader.cancel() before reader.releaseLock() in both return()
 * and throw(), matching the pattern already used in event-stream.ts and s2s.
 */

/**
 * Creates a ReadableStream subclass with the same manual async iterator
 * pattern used by FetchReadSession, to test cancel behavior in isolation.
 */
function createTestStream(
	items: string[],
	variant: "buggy" | "fixed",
): {
	stream: ReadableStream<string> & AsyncIterable<string>;
	cancelCalled: () => boolean;
	cancelReason: () => unknown;
} {
	let _cancelCalled = false;
	let _cancelReason: unknown = undefined;

	const underlying = new ReadableStream<string>({
		start(controller) {
			for (const item of items) {
				controller.enqueue(item);
			}
			controller.close();
		},
		cancel(reason) {
			_cancelCalled = true;
			_cancelReason = reason;
		},
	});

	// Wrap the ReadableStream with a manual async iterator, mirroring
	// FetchReadSession's polyfill.
	const reader = underlying.getReader();

	const iterable = {
		[Symbol.asyncIterator](): AsyncIterableIterator<string> {
			return {
				next: async () => {
					const r = await reader.read();
					if (r.done) return { done: true as const, value: undefined };
					return { done: false as const, value: r.value };
				},
				return: async (value?: any) => {
					if (variant === "fixed") {
						try {
							await reader.cancel();
						} catch (err: any) {
							if (err?.code !== "ERR_INVALID_STATE") throw err;
						}
					}
					reader.releaseLock();
					return { done: true as const, value };
				},
				throw: async (e?: any) => {
					if (variant === "fixed") {
						try {
							await reader.cancel(e);
						} catch (err: any) {
							if (err?.code !== "ERR_INVALID_STATE") throw err;
						}
					}
					reader.releaseLock();
					throw e;
				},
				[Symbol.asyncIterator]() {
					return this;
				},
			};
		},
	};

	return {
		stream: iterable as any,
		cancelCalled: () => _cancelCalled,
		cancelReason: () => _cancelReason,
	};
}

describe("Issue #166: fetch transport iterator must cancel on early termination", () => {
	it("buggy variant: return() does NOT cancel the underlying stream", async () => {
		const { stream, cancelCalled } = createTestStream(
			["a", "b", "c"],
			"buggy",
		);
		const iter = stream[Symbol.asyncIterator]();

		// Read one item then early-return
		const first = await iter.next();
		expect(first).toEqual({ done: false, value: "a" });

		await iter.return!();

		// The buggy version never cancels - this is the leak
		expect(cancelCalled()).toBe(false);
	});

	it("fixed variant: return() cancels the underlying stream", async () => {
		const { stream, cancelCalled } = createTestStream(
			["a", "b", "c"],
			"fixed",
		);
		const iter = stream[Symbol.asyncIterator]();

		// Read one item then early-return
		const first = await iter.next();
		expect(first).toEqual({ done: false, value: "a" });

		await iter.return!();

		// The fixed version must cancel to free resources
		expect(cancelCalled()).toBe(true);
	});

	it("fixed variant: throw() cancels the underlying stream", async () => {
		const { stream, cancelCalled } = createTestStream(
			["a", "b", "c"],
			"fixed",
		);
		const iter = stream[Symbol.asyncIterator]();

		// Read one item then throw
		await iter.next();

		await expect(iter.throw!(new Error("abort"))).rejects.toThrow("abort");

		// The fixed version must cancel to free resources
		expect(cancelCalled()).toBe(true);
	});

	it("fixed variant: for-await break cancels the stream", async () => {
		const { stream, cancelCalled } = createTestStream(
			["a", "b", "c"],
			"fixed",
		);

		const collected: string[] = [];
		for await (const item of stream) {
			collected.push(item);
			if (collected.length === 1) break;
		}

		expect(collected).toEqual(["a"]);
		expect(cancelCalled()).toBe(true);
	});

	it("fixed variant: return() after exhaustion does not throw", async () => {
		const { stream } = createTestStream(["x"], "fixed");
		const iter = stream[Symbol.asyncIterator]();

		// Exhaust the stream
		await iter.next(); // { done: false, value: "x" }
		await iter.next(); // { done: true }

		// return() after done should not throw (ERR_INVALID_STATE is caught)
		const result = await iter.return!();
		expect(result).toEqual({ done: true, value: undefined });
	});
});
