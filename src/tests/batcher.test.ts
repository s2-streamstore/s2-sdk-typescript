import { describe, expect, it } from "vitest";
import { BatchTransform } from "../batch-transform.js";
import { S2Error } from "../error.js";

describe("BatchTransform", () => {
	it("close() flushes remaining records", async () => {
		const batcher = new BatchTransform<"string">({
			lingerDuration: 1000,
			maxBatchRecords: 10,
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		const writePromise = (async () => {
			await writer.write({ format: "string", body: "x" });
			await writer.close();
		})();

		const result = await reader.read();
		expect(result.done).toBe(false);
		expect(result.value?.records).toHaveLength(1);

		await writePromise;
		reader.releaseLock();
	});

	it("propagates fencing_token and auto-increments match_seq_num across batches", async () => {
		const batcher = new BatchTransform<"string">({
			lingerDuration: 0,
			maxBatchRecords: 2,
			fencing_token: "ft",
			match_seq_num: 10,
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		const writePromise = (async () => {
			// First batch: two records
			await writer.write({ format: "string", body: "a" });
			await writer.write({ format: "string", body: "b" });
			// Second batch: one record
			await writer.write({ format: "string", body: "c" });
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

	it("rejects records with inconsistent format", async () => {
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
		expect(error.message).toContain("Cannot batch");
	});

	it("flushes immediately when max records reached", async () => {
		const batcher = new BatchTransform<"string">({
			lingerDuration: 1000, // Long linger
			maxBatchRecords: 2,
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		const writePromise = (async () => {
			await writer.write({ format: "string", body: "a" });
			await writer.write({ format: "string", body: "b" });
			await writer.write({ format: "string", body: "c" });
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
		const batcher = new BatchTransform<"string">({
			lingerDuration: 1000,
			maxBatchBytes: 30, // Small batch size
		});

		const writer = batcher.writable.getWriter();
		const reader = batcher.readable.getReader();

		const writePromise = (async () => {
			// Each record is ~13 bytes (8 overhead + 5 body)
			await writer.write({ format: "string", body: "hello" });
			await writer.write({ format: "string", body: "world" });
			await writer.write({ format: "string", body: "test!" });
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
