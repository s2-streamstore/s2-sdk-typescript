import { describe, expect, it } from "vitest";
import { BatchTransform } from "../batch-transform.js";
import { S2Error } from "../error.js";

describe("BatchTransform", () => {
	it("close() flushes remaining records", async () => {
		const batcher = new BatchTransform({
			lingerDuration: 1000,
			maxBatchRecords: 10,
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		const writePromise = (async () => {
			await writer.write({ body: "x" });
			await writer.close();
		})();

		const result = await reader.read();
		expect(result.done).toBe(false);
		expect(result.value?.records).toHaveLength(1);

		await writePromise;
		reader.releaseLock();
	});

	it("propagates fencing_token and auto-increments match_seq_num across batches", async () => {
		const batcher = new BatchTransform({
			lingerDuration: 0,
			maxBatchRecords: 2,
			fencing_token: "ft",
			match_seq_num: 10,
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		const writePromise = (async () => {
			// First batch: two records
			await writer.write({ body: "a" });
			await writer.write({ body: "b" });
			// Second batch: one record
			await writer.write({ body: "c" });
			await writer.close();
		})();

		// First batch should have match_seq_num: 10 (2 records)
		const result1 = await reader.read();
		expect(result1.done).toBe(false);
		expect(result1.value?.records).toHaveLength(2);
		expect(result1.value?.fencing_token).toBe("ft");
		expect(result1.value?.match_seq_num).toBe(10);

		// Second batch should have match_seq_num: 12 (incremented by 2)
		const result2 = await reader.read();
		expect(result2.done).toBe(false);
		expect(result2.value?.records).toHaveLength(1);
		expect(result2.value?.fencing_token).toBe("ft");
		expect(result2.value?.match_seq_num).toBe(12);

		await writePromise;
		reader.releaseLock();
	});

	it("flushes immediately when max records reached", async () => {
		const batcher = new BatchTransform({
			lingerDuration: 1000, // Long linger
			maxBatchRecords: 2,
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		const writePromise = (async () => {
			await writer.write({ body: "a" });
			await writer.write({ body: "b" });
			await writer.write({ body: "c" });
			await writer.close();
		})();

		// First batch should flush immediately with 2 records
		const result1 = await reader.read();
		expect(result1.done).toBe(false);
		expect(result1.value?.records).toHaveLength(2);

		// Second batch should have 1 record (flushed on close)
		const result2 = await reader.read();
		expect(result2.done).toBe(false);
		expect(result2.value?.records).toHaveLength(1);

		await writePromise;
		reader.releaseLock();
	});

	it("flushes when max bytes reached", async () => {
		const batcher = new BatchTransform({
			lingerDuration: 1000,
			maxBatchBytes: 30, // Small batch size
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		const writePromise = (async () => {
			// Each record is ~13 bytes (8 overhead + 5 body)
			await writer.write({ body: "hello" });
			await writer.write({ body: "world" });
			await writer.write({ body: "test!" });
			await writer.close();
		})();

		// Should get first batch with 2 records
		const result1 = await reader.read();
		expect(result1.done).toBe(false);
		expect(result1.value?.records).toHaveLength(2);

		// Third record starts new batch
		const result2 = await reader.read();
		expect(result2.done).toBe(false);
		expect(result2.value?.records).toHaveLength(1);

		await writePromise;
		reader.releaseLock();
	});
});
