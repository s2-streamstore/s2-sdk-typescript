import { describe, expect, it } from "vitest";
import { DeserializingReadSession } from "../../patterns/serialization.js";
import { makeFrameHeaders } from "../../patterns/framing.js";
import type { ReadSession } from "@s2-dev/streamstore";

/**
 * Issue #180: DeserializingReadSession leaks reader lock and does not cancel
 * upstream on read/deserialization errors.
 *
 * When `deserialize()` (or any other operation in the `start()` read loop)
 * throws, the reader lock acquired via `session.getReader()` is never released
 * and `session.cancel()` is never called. This leaves the underlying session
 * permanently locked and its resources leaked.
 *
 * The fix wraps the read loop in try/catch so that on error:
 *   1. `controller.error(e)` signals the error downstream
 *   2. `reader.releaseLock()` releases the reader lock
 *   3. `session.cancel(e)` propagates the error upstream
 */

function createMockReadSession(
	records: Array<{
		headers: Array<readonly [Uint8Array, Uint8Array]>;
		body: Uint8Array;
	}>,
	options?: { keepOpen?: boolean },
): ReadSession<"bytes"> & { cancelCalled: boolean; cancelReason: unknown } {
	const state = { cancelCalled: false, cancelReason: undefined as unknown };
	const queue = records.map((r) => ({
		seqNum: 0,
		body: r.body,
		headers: r.headers,
		timestamp: new Date(),
	}));
	let queueIndex = 0;

	const stream = new ReadableStream({
		pull(controller) {
			if (queueIndex < queue.length) {
				controller.enqueue(queue[queueIndex++]);
			} else if (!options?.keepOpen) {
				controller.close();
			}
			// When keepOpen is true, do nothing after records are exhausted —
			// the stream stays open so cancel() can still be invoked.
		},
		cancel(reason) {
			state.cancelCalled = true;
			state.cancelReason = reason;
		},
	});

	// Use a Proxy so that ReadSession interface methods are available while
	// preserving the native ReadableStream.cancel() behavior (Object.assign
	// overriding cancel on a ReadableStream instance breaks the internal slot
	// linkage).
	const extras = {
		nextReadPosition: () => undefined,
		lastObservedTail: () => undefined,
		[Symbol.asyncDispose]: async () => {},
	};

	return new Proxy(stream, {
		get(target, prop, receiver) {
			if (prop === "cancelCalled") return state.cancelCalled;
			if (prop === "cancelReason") return state.cancelReason;
			if (prop in extras) {
				return (extras as any)[prop];
			}
			const value = Reflect.get(target, prop, target);
			if (typeof value === "function") {
				return value.bind(target);
			}
			return value;
		},
	}) as ReadSession<"bytes"> & {
		cancelCalled: boolean;
		cancelReason: unknown;
	};
}

describe("Issue #180: DeserializingReadSession should release reader lock and cancel upstream on error", () => {
	it("releases the reader lock when deserialize() throws", async () => {
		const payload = new Uint8Array([1, 2, 3, 4]);
		const headers = makeFrameHeaders(payload.length, 1);

		const session = createMockReadSession([{ headers, body: payload }]);

		const deserSession = new DeserializingReadSession(
			session,
			() => {
				throw new Error("DESERIALIZE_FAILED");
			},
			{ enableDedupe: false },
		);

		// Consume the stream — should surface the deserialize error
		const reader = deserSession.getReader();
		await expect(reader.read()).rejects.toThrow("DESERIALIZE_FAILED");

		// The underlying session should NOT be locked after the error
		expect(session.locked).toBe(false);
	});

	it("cancels the upstream session when deserialize() throws", async () => {
		const payload = new Uint8Array([1, 2, 3, 4]);
		const headers = makeFrameHeaders(payload.length, 1);

		// keepOpen simulates a long-lived stream that hasn't ended yet, so the
		// underlying source's cancel() callback is reachable.
		const session = createMockReadSession([{ headers, body: payload }], {
			keepOpen: true,
		});

		const deserSession = new DeserializingReadSession(
			session,
			() => {
				throw new Error("DESERIALIZE_FAILED");
			},
			{ enableDedupe: false },
		);

		// Consume the stream — should surface the deserialize error
		try {
			for await (const _chunk of deserSession) {
				// should not reach here
			}
		} catch {
			// expected
		}

		// Upstream session should have been canceled
		expect(session.cancelCalled).toBe(true);
	});

	it("propagates the error to consumers via the stream", async () => {
		const payload = new Uint8Array([1, 2, 3, 4]);
		const headers = makeFrameHeaders(payload.length, 1);

		const session = createMockReadSession([{ headers, body: payload }]);

		const deserSession = new DeserializingReadSession(
			session,
			() => {
				throw new Error("DESERIALIZE_FAILED");
			},
			{ enableDedupe: false },
		);

		// The error should be surfaced when consuming
		await expect(async () => {
			for await (const _chunk of deserSession) {
				// should not reach here
			}
		}).rejects.toThrow("DESERIALIZE_FAILED");
	});

	it("still works normally when no error occurs", async () => {
		const payload = new Uint8Array([10, 20, 30]);
		const headers = makeFrameHeaders(payload.length, 1);

		const session = createMockReadSession([{ headers, body: payload }]);

		const deserSession = new DeserializingReadSession(
			session,
			(p) => ({ data: Array.from(p) }),
			{ enableDedupe: false },
		);

		const results: Array<{ data: number[] }> = [];
		for await (const msg of deserSession) {
			results.push(msg as { data: number[] });
		}

		expect(results).toHaveLength(1);
		expect(results[0].data).toEqual([10, 20, 30]);
	});
});
