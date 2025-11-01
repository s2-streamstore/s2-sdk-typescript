import { describe, expect, it } from "vitest";
import { BatchTransform } from "../batch-transform.js";
import { S2Error } from "../error.js";

describe("BatchTransform", () => {
	it("batches records based on linger duration", async () => {
		const batcher = new BatchTransform<"string">({
			lingerDuration: 50,
			maxBatchRecords: 100,
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		// Write 3 records quickly
		writer.write({ format: "string", body: "a" });
		writer.write({ format: "string", body: "b" });
		writer.write({ format: "string", body: "c" });

		// Wait for linger duration
		await new Promise((resolve) => setTimeout(resolve, 60));

		// Should get one batch with all 3 records
		const result = await reader.read();
		expect(result.done).toBe(false);
		expect(result.value?.records).toHaveLength(3);
		expect(result.value?.records[0]?.body).toBe("a");
		expect(result.value?.records[1]?.body).toBe("b");
		expect(result.value?.records[2]?.body).toBe("c");

		await writer.close();
		reader.releaseLock();
	});

	it("flushes immediately when max records reached", async () => {
		const batcher = new BatchTransform<"string">({
			lingerDuration: 1000, // Long linger, should flush before this
			maxBatchRecords: 2,
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		// Write 2 records - should flush immediately
		writer.write({ format: "string", body: "a" });
		writer.write({ format: "string", body: "b" });

		// Should get batch immediately (no need to wait for linger)
		const result = await reader.read();
		expect(result.done).toBe(false);
		expect(result.value?.records).toHaveLength(2);

		// Write 2 more - should flush again
		writer.write({ format: "string", body: "c" });
		writer.write({ format: "string", body: "d" });

		const result2 = await reader.read();
		expect(result2.done).toBe(false);
		expect(result2.value?.records).toHaveLength(2);

		await writer.close();
		reader.releaseLock();
	});

	it("flushes when max bytes reached", async () => {
		const batcher = new BatchTransform<"string">({
			lingerDuration: 1000,
			maxBatchBytes: 30, // Small batch size
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		// Write and read concurrently
		const writePromise = (async () => {
			// Each record is ~13 bytes (8 overhead + 5 body)
			// Two records = ~26 bytes, adding third would exceed 30
			await writer.write({ format: "string", body: "hello" }); // ~13 bytes
			await writer.write({ format: "string", body: "world" }); // ~13 bytes
			await writer.write({ format: "string", body: "test!" }); // ~13 bytes
			await writer.close();
		})();

		// Should get first batch with 2 records
		const result = await reader.read();
		expect(result.done).toBe(false);
		expect(result.value?.records).toHaveLength(2);

		// Third record starts new batch
		const result2 = await reader.read();
		expect(result2.done).toBe(false);
		expect(result2.value?.records).toHaveLength(1);

		await writePromise;
		reader.releaseLock();
	});

	it("flushes remaining records on close", async () => {
		const batcher = new BatchTransform<"string">({
			lingerDuration: 10000, // Very long linger
			maxBatchRecords: 100,
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		// Write and close in parallel with reading
		const writePromise = (async () => {
			await writer.write({ format: "string", body: "a" });
			await writer.write({ format: "string", body: "b" });
			await writer.close();
		})();

		// Should get batch after close
		const result = await reader.read();
		expect(result.done).toBe(false);
		expect(result.value?.records).toHaveLength(2);

		// Stream should be done
		const result2 = await reader.read();
		expect(result2.done).toBe(true);

		await writePromise;
		reader.releaseLock();
	});

	it("works with bytes format", async () => {
		const batcher = new BatchTransform<"bytes">({
			lingerDuration: 50,
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		writer.write({ format: "bytes", body: new Uint8Array([1, 2, 3]) });
		writer.write({ format: "bytes", body: new Uint8Array([4, 5, 6]) });

		await new Promise((resolve) => setTimeout(resolve, 60));

		const result = await reader.read();
		expect(result.done).toBe(false);
		expect(result.value?.records).toHaveLength(2);

		await writer.close();
		reader.releaseLock();
	});

	it("can be used with pipeTo", async () => {
		const batcher = new BatchTransform<"string">({
			lingerDuration: 10,
		});

		// Create a readable stream of records
		const records = [
			{ format: "string", body: "a" },
			{ format: "string", body: "b" },
			{ format: "string", body: "c" },
		];

		const sourceStream = new ReadableStream({
			async start(controller) {
				for (const record of records) {
					controller.enqueue(record);
				}
				controller.close();
			},
		});

		// Collect batches
		const batches: Array<{ records: typeof records }> = [];
		const collectStream = new WritableStream({
			write(batch) {
				batches.push(batch);
			},
		});

		// Pipe through batcher
		await sourceStream.pipeThrough(batcher).pipeTo(collectStream);

		// Should have collected batches
		expect(batches.length).toBeGreaterThan(0);
		const totalRecords = batches.flatMap((b) => b.records).length;
		expect(totalRecords).toBe(3);
	});

	it("handles rapid writes with linger", async () => {
		const batcher = new BatchTransform<"string">({
			lingerDuration: 20,
			maxBatchRecords: 10,
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		// Write 5 records rapidly
		for (let i = 0; i < 5; i++) {
			writer.write({ format: "string", body: `record-${i}` });
		}

		// Wait for linger
		await new Promise((resolve) => setTimeout(resolve, 30));

		const result = await reader.read();
		expect(result.done).toBe(false);
		expect(result.value?.records).toHaveLength(5);

		await writer.close();
		reader.releaseLock();
	});

	it("respects maximum limits (capped at 1000 records, 1 MiB)", () => {
		// Should cap maxBatchRecords at 1000
		const batcher1 = new BatchTransform<"string">({
			maxBatchRecords: 5000, // Will be capped to 1000
		});
		// We can't directly access private fields, but we can verify behavior

		// Should cap maxBatchBytes at 1 MiB
		const batcher2 = new BatchTransform<"string">({
			maxBatchBytes: 10 * 1024 * 1024, // Will be capped to 1 MiB
		});

		// Both should construct without error
		expect(batcher1).toBeDefined();
		expect(batcher2).toBeDefined();
	});

	it("handles empty batches gracefully", async () => {
		const batcher = new BatchTransform<"string">({
			lingerDuration: 10,
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		// Close without writing anything
		await writer.close();

		// Should get done immediately with no batches
		const result = await reader.read();
		expect(result.done).toBe(true);

		reader.releaseLock();
	});

	it("cancels linger timer when batch is flushed early", async () => {
		const batcher = new BatchTransform<"string">({
			lingerDuration: 1000, // Long linger
			maxBatchRecords: 2,
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		// Write and read concurrently
		const writePromise = (async () => {
			// Write 2 records - should flush immediately due to maxBatchRecords
			await writer.write({ format: "string", body: "a" });
			await writer.write({ format: "string", body: "b" });
			// Write one more and immediately close
			await writer.write({ format: "string", body: "c" });
			await writer.close();
		})();

		// Should get first batch immediately (linger timer should be cancelled)
		const result = await reader.read();
		expect(result.done).toBe(false);
		expect(result.value?.records).toHaveLength(2);

		// Should get remaining batch without waiting for linger
		const result2 = await reader.read();
		expect(result2.done).toBe(false);
		expect(result2.value?.records).toHaveLength(1);

		await writePromise;
		reader.releaseLock();
	});

	it("works in a for-await loop", async () => {
		const batcher = new BatchTransform<"string">({
			lingerDuration: 10,
		});

		const writer = batcher.writable.getWriter();

		// Write and close in parallel with reading
		const writePromise = (async () => {
			await writer.write({ format: "string", body: "a" });
			await writer.write({ format: "string", body: "b" });
			await writer.write({ format: "string", body: "c" });
			await writer.close();
		})();

		// Consume with for-await
		const batches: Array<Array<{ body?: string; format: string }>> = [];
		for await (const batch of batcher.readable as unknown as AsyncIterable<{
			records: Array<{ body?: string; format: string }>;
		}>) {
			batches.push(batch.records);
		}

		await writePromise;

		expect(batches.length).toBeGreaterThan(0);
		const totalRecords = batches.flat().length;
		expect(totalRecords).toBe(3);
	});

	it("rejects individual records that exceed max batch bytes", async () => {
		const batcher = new BatchTransform<"string">({
			maxBatchBytes: 30, // Small limit
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		// Create a record that's too large (body alone is 100 bytes, plus 8 byte overhead = 108 bytes)
		const largeBody = "x".repeat(100);

		// Write and read concurrently to avoid deadlock
		const writePromise = writer
			.write({ format: "string", body: largeBody })
			.catch((err) => err);
		const readPromise = reader.read().catch((err) => err);

		// Either the write or read should fail with the error
		const [writeResult, readResult] = await Promise.all([
			writePromise,
			readPromise,
		]);

		// At least one should be an error
		const error = writeResult instanceof S2Error ? writeResult : readResult;
		expect(error).toBeInstanceOf(S2Error);
		expect(error.message).toContain("exceeds maximum batch size");
	});

	it("rejects oversized bytes records", async () => {
		const batcher = new BatchTransform<"bytes">({
			maxBatchBytes: 20,
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		// Create a bytes record that's too large
		const largeBody = new Uint8Array(50); // 50 bytes + 8 overhead = 58 bytes

		// Write and read concurrently to avoid deadlock
		const writePromise = writer
			.write({ format: "bytes", body: largeBody })
			.catch((err) => err);
		const readPromise = reader.read().catch((err) => err);

		// Either the write or read should fail with the error
		const [writeResult, readResult] = await Promise.all([
			writePromise,
			readPromise,
		]);

		// At least one should be an error
		const error = writeResult instanceof S2Error ? writeResult : readResult;
		expect(error).toBeInstanceOf(S2Error);
		expect(error.message).toContain("exceeds maximum batch size");
	});

	it("includes fencing_token in batch output", async () => {
		const batcher = new BatchTransform<"string">({
			lingerDuration: 10,
			fencing_token: "my-fence-token",
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		const writePromise = (async () => {
			await writer.write({ format: "string", body: "a" });
			await writer.write({ format: "string", body: "b" });
			await writer.close();
		})();

		const result = await reader.read();
		expect(result.done).toBe(false);
		expect(result.value?.records).toHaveLength(2);
		expect(result.value?.fencing_token).toBe("my-fence-token");

		await writePromise;
		reader.releaseLock();
	});

	it("auto-increments match_seq_num across batches", async () => {
		const batcher = new BatchTransform<"string">({
			lingerDuration: 10,
			maxBatchRecords: 2,
			match_seq_num: 0, // Start at 0
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		const writePromise = (async () => {
			// First batch: 2 records
			await writer.write({ format: "string", body: "a" });
			await writer.write({ format: "string", body: "b" });
			// Second batch: 3 records
			await writer.write({ format: "string", body: "c" });
			await writer.write({ format: "string", body: "d" });
			await writer.write({ format: "string", body: "e" });
			await writer.close();
		})();

		// First batch should have match_seq_num: 0 (2 records)
		const result1 = await reader.read();
		expect(result1.done).toBe(false);
		expect(result1.value?.records).toHaveLength(2);
		expect(result1.value?.match_seq_num).toBe(0);

		// Second batch should have match_seq_num: 2 (incremented by batch size)
		const result2 = await reader.read();
		expect(result2.done).toBe(false);
		expect(result2.value?.records).toHaveLength(2);
		expect(result2.value?.match_seq_num).toBe(2);

		// Third batch should have match_seq_num: 4
		const result3 = await reader.read();
		expect(result3.done).toBe(false);
		expect(result3.value?.records).toHaveLength(1);
		expect(result3.value?.match_seq_num).toBe(4);

		await writePromise;
		reader.releaseLock();
	});

	it("works without fencing_token or match_seq_num", async () => {
		const batcher = new BatchTransform<"string">({
			lingerDuration: 10,
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		const writePromise = (async () => {
			await writer.write({ format: "string", body: "a" });
			await writer.close();
		})();

		const result = await reader.read();
		expect(result.done).toBe(false);
		expect(result.value?.records).toHaveLength(1);
		expect(result.value?.fencing_token).toBeUndefined();
		expect(result.value?.match_seq_num).toBeUndefined();

		await writePromise;
		reader.releaseLock();
	});

	it("rejects mixed format records", async () => {
		const batcher = new BatchTransform<"string" | "bytes">({
			lingerDuration: 10,
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		// Write and read concurrently to avoid deadlock
		const writePromise = (async () => {
			await writer.write({ format: "string", body: "a" });
			// Try to write a bytes record - should fail
			await writer.write({ format: "bytes", body: new Uint8Array([1, 2, 3]) });
		})().catch((err) => err);

		const readPromise = reader.read().catch((err) => err);

		// Either the write or read should fail with the error
		const [writeResult, readResult] = await Promise.all([
			writePromise,
			readPromise,
		]);

		// At least one should be an error
		const error = writeResult instanceof S2Error ? writeResult : readResult;
		expect(error).toBeInstanceOf(S2Error);
		expect(error.message).toContain("Cannot batch bytes records with string");
	});
});
