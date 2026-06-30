import { describe, expect, it } from "vitest";
import { readableStreamToAsyncIterable } from "../../index.js";

// Issue #275: stopping one tee branch early must not hang cancel() on the other.

function ongoingSource(): ReadableStream<string> {
	return new ReadableStream<string>({
		start(controller) {
			controller.enqueue("a");
			controller.enqueue("b");
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

describe("Issue #275: cancelling one tee branch after the other stops early", () => {
	it("does not hang cancel() on the other branch", async () => {
		const [persistent, client] = ongoingSource().tee();

		const iterator =
			readableStreamToAsyncIterable(persistent)[Symbol.asyncIterator]();
		await iterator.next();
		await iterator.return?.(undefined);

		const result = await withTimeout(client.cancel(), 500);
		expect(result).not.toBe("TIMEOUT");
	});
});
