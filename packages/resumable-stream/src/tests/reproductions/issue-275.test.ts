import { describe, expect, it } from "vitest";
import { readableStreamToAsyncIterable } from "../../index.js";

/**
 * Issue #275: persistence consumes one teed branch via
 * readableStreamToAsyncIterable. When that iteration stops early it released
 * the reader lock without cancelling, leaving the branch abandoned — so a
 * later cancel() on the sibling (client) branch never resolved. The fix
 * fire-and-forget cancels the branch in the generator's finally block.
 */

function ongoingSource(): ReadableStream<string> {
	return new ReadableStream<string>({
		start(controller) {
			controller.enqueue("a");
			controller.enqueue("b");
			// Never closes: simulates a producer still emitting tokens.
		},
	});
}

async function withTimeout<T>(
	p: Promise<T>,
	ms: number,
): Promise<T | "TIMEOUT"> {
	return Promise.race([
		p,
		new Promise<"TIMEOUT">((resolve) =>
			setTimeout(() => resolve("TIMEOUT"), ms),
		),
	]);
}

describe("Issue #275: cancelling the client branch after persistence stops early", () => {
	it("does not hang the sibling branch's cancel()", async () => {
		const [persistent, client] = ongoingSource().tee();

		// Persistence reads one value, then stops early (loop body breaks/throws).
		const iterable = readableStreamToAsyncIterable(persistent);
		const iterator = iterable[Symbol.asyncIterator]();
		await iterator.next();
		await iterator.return?.(undefined); // runs the generator's finally

		// The client now cancels its branch; this must resolve promptly.
		const result = await withTimeout(client.cancel(), 500);
		expect(result).not.toBe("TIMEOUT");
	});
});
