import { describe, expect, it } from "vitest";
import { BatchTransform } from "../../batch-transform.js";
import { AppendRecord } from "../../index.js";

describe("issue-136: BatchTransform linger timer bugs", () => {
	it("0ms linger flushes", async () => {
		const batcher = new BatchTransform({ lingerDurationMillis: 0 });
		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		const record = AppendRecord.string({ body: "hello" });

		// Start reading before writing so the read promise is waiting
		const readPromise = reader.read();

		await writer.write(record);

		// Wait for the setTimeout(..., 0) linger timer to fire
		await new Promise((resolve) => setTimeout(resolve, 50));

		const { value, done } = await readPromise;
		expect(done).toBe(false);
		expect(value).toBeDefined();
		expect(value!.records.length).toBe(1);

		await writer.close();
		reader.releaseLock();
	});

	it("cancel clears linger timer", async () => {
		const batcher = new BatchTransform({ lingerDurationMillis: 50 });

		const record = AppendRecord.string({ body: "hello" });

		// Use pipeTo with an AbortController to properly cancel the stream
		const ac = new AbortController();

		// Create a source readable that emits one record then waits
		const source = new ReadableStream({
			start(controller) {
				controller.enqueue(record);
			},
		});

		// Pipe through the batcher to a sink, with abort signal
		const pipePromise = source.pipeThrough(batcher).pipeTo(
			new WritableStream(),
			{ signal: ac.signal },
		).catch(() => {
			// Expected: abort causes pipeline error
		});

		// Wait a tick so the record enters the transform
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Abort the pipeline, which should trigger cancel on the transform
		ac.abort();
		await pipePromise;

		// Wait longer than the linger duration - before the fix, the timer
		// would fire and call enqueue on a closed controller, crashing.
		await new Promise((resolve) => setTimeout(resolve, 100));

		// If we reach here without an unhandled exception, the fix works.
		expect(true).toBe(true);
	});

	it("controller set in start so flush works on close", async () => {
		const batcher = new BatchTransform({ lingerDurationMillis: 10000 });
		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		const record = AppendRecord.string({ body: "hello" });

		// Start reading before writing
		const readPromise = reader.read();

		await writer.write(record);
		await writer.close();

		// The flush callback runs on close. Controller was set in start
		// via the local variable bridge, so flush always works.
		const { value, done } = await readPromise;
		expect(done).toBe(false);
		expect(value).toBeDefined();
		expect(value!.records.length).toBe(1);

		reader.releaseLock();
	});
});
