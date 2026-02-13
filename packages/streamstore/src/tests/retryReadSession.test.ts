import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { S2Error } from "../error.js";
import type { StreamPosition } from "../generated/index.js";
import { RetryReadSession } from "../lib/retry.js";
import type {
	ReadRecord as InternalReadRecord,
	ReadArgs,
	ReadResult,
	TransportReadSession,
} from "../lib/stream/types.js";
import type { ReadRecord as SDKReadRecord } from "../types.js";

/**
 * Fake TransportReadSession for testing ReadSession.
 * Implements the transport layer pattern: yields ReadResult and never throws.
 */
class FakeReadSession<Format extends "string" | "bytes" = "string">
	extends ReadableStream<ReadResult<Format>>
	implements TransportReadSession<Format>
{
	public recordsEmitted = 0;

	constructor(
		private readonly behavior: {
			// Records to emit before erroring (if errorAfterRecords is set)
			records: Array<InternalReadRecord<Format>>;
			// Error after emitting this many records (undefined = no error)
			errorAfterRecords?: number;
			// Error to emit as error result
			error?: S2Error;
			// Tail position to report (simulates being near the tail)
			tail?: StreamPosition;
		},
	) {
		let emittedCount = 0; // Use local variable in super() callback
		super({
			pull: (controller) => {
				// Check if we should error before emitting any more records
				if (
					behavior.errorAfterRecords !== undefined &&
					emittedCount >= behavior.errorAfterRecords
				) {
					// Emit error result instead of throwing
					controller.enqueue({
						ok: false,
						error:
							behavior.error ?? new S2Error({ message: "boom", status: 500 }),
					});
					controller.close();
					return;
				}

				// Emit records one at a time as they're requested
				if (emittedCount < behavior.records.length) {
					// Emit success result
					controller.enqueue({
						ok: true,
						value: behavior.records[emittedCount]!,
					});
					emittedCount++;

					// Check if we should error after emitting this record
					if (
						behavior.errorAfterRecords !== undefined &&
						emittedCount >= behavior.errorAfterRecords
					) {
						// Emit error result instead of throwing
						controller.enqueue({
							ok: false,
							error:
								behavior.error ?? new S2Error({ message: "boom", status: 500 }),
						});
						controller.close();
						return;
					}
				} else {
					// All records emitted
					controller.close();
				}
			},
		});
		this.recordsEmitted = behavior.errorAfterRecords ?? behavior.records.length;
	}

	nextReadPosition(): StreamPosition | undefined {
		if (this.recordsEmitted === 0) return undefined;
		const lastRecord = this.behavior.records[this.recordsEmitted - 1];
		if (!lastRecord) return undefined;
		return {
			seq_num: lastRecord.seq_num + 1,
			timestamp: lastRecord.timestamp,
		};
	}

	lastObservedTail(): StreamPosition | undefined {
		return this.behavior.tail;
	}

	// Implement AsyncIterable (for await...of support)
	[Symbol.asyncIterator](): AsyncIterableIterator<ReadResult<Format>> {
		const fn = (ReadableStream.prototype as any)[Symbol.asyncIterator];
		if (typeof fn === "function") return fn.call(this);
		const reader = this.getReader();
		return {
			next: async () => {
				const r = await reader.read();
				if (r.done) return { done: true, value: undefined };
				return { done: false, value: r.value };
			},
			return: async (value?: any) => {
				reader.releaseLock();
				return { done: true, value };
			},
			throw: async (e?: any) => {
				reader.releaseLock();
				throw e;
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		};
	}

	// Implement AsyncDisposable (using Disposable)
	async [Symbol.asyncDispose](): Promise<void> {
		await this.cancel();
	}
}

describe("ReadSession (unit)", () => {
	// Note: Not using fake timers here because they don't play well with async iteration
	// Instead, we use very short backoff times (1ms) to make tests run fast

	it("adjusts count parameter on retry after partial read", async () => {
		const records: InternalReadRecord<"string">[] = [
			{ seq_num: 0, timestamp: 0, body: "a" },
			{ seq_num: 1, timestamp: 0, body: "b" },
			{ seq_num: 2, timestamp: 0, body: "c" },
		];

		let callCount = 0;
		const capturedArgs: Array<ReadArgs<"string">> = [];

		const session = await RetryReadSession.create(
			async (args) => {
				capturedArgs.push({ ...args });
				callCount++;
				if (callCount === 1) {
					// First call: emit 3 records then error
					return new FakeReadSession({
						records,
						errorAfterRecords: 3,
						error: new S2Error({ message: "transient error", status: 500 }),
					});
				}
				// Second call: emit remaining records (none in this case, but succeed)
				return new FakeReadSession({ records: [] });
			},
			{ count: 10 }, // Request 10 records
			{ minBaseDelayMillis: 1, maxBaseDelayMillis: 1, maxAttempts: 2 },
		);

		// Consume all records
		const results: SDKReadRecord<"string">[] = [];
		for await (const record of session) {
			results.push(record);
		}

		// Verify we got all 3 records (transport explicitly emits them as success before error)
		expect(results).toHaveLength(3);

		// Verify retry adjusted count: 10 - 3 = 7
		expect(capturedArgs).toHaveLength(2);
		expect(capturedArgs[0]?.count).toBe(10);
		expect(capturedArgs[1]?.count).toBe(7);
	});

	it("adjusts bytes parameter on retry after partial read", async () => {
		// Each record is ~50 bytes (rough estimate with body + overhead)
		const records: InternalReadRecord<"string">[] = [
			{ seq_num: 0, timestamp: 0, body: "x".repeat(42) }, // ~50 bytes
			{ seq_num: 1, timestamp: 0, body: "y".repeat(42) }, // ~50 bytes
		];

		let callCount = 0;
		const capturedArgs: Array<ReadArgs<"string">> = [];

		const session = await RetryReadSession.create(
			async (args) => {
				capturedArgs.push({ ...args });
				callCount++;
				if (callCount === 1) {
					// First call: emit 2 records (~100 bytes) then error
					return new FakeReadSession({
						records,
						errorAfterRecords: 2,
						error: new S2Error({ message: "transient error", status: 500 }),
					});
				}
				// Second call: succeed
				return new FakeReadSession({ records: [] });
			},
			{ bytes: 500 }, // Request 500 bytes
			{ minBaseDelayMillis: 1, maxBaseDelayMillis: 1, maxAttempts: 2 },
		);

		// Consume all records
		const results: SDKReadRecord<"string">[] = [];
		for await (const record of session) {
			results.push(record);
		}

		// Verify we got both records (transport explicitly emits them as success before error)
		expect(results).toHaveLength(2);

		// Verify retry adjusted bytes: should be less than 500
		expect(capturedArgs).toHaveLength(2);
		expect(capturedArgs[0]?.bytes).toBe(500);
		expect(capturedArgs[1]?.bytes).toBeLessThan(500);
		// Each record is approximately 50 bytes, so should be around 500 - 100 = 400
		expect(capturedArgs[1]?.bytes).toBeGreaterThan(350);
	});

	it("adjusts wait parameter based on elapsed time", async () => {
		const tail: StreamPosition = { seq_num: 100, timestamp: 0 };
		const records: InternalReadRecord<"string">[] = [
			{ seq_num: 0, timestamp: 0, body: "a" },
		];

		let callCount = 0;
		const capturedArgs: Array<ReadArgs<"string">> = [];

		const session = await RetryReadSession.create(
			async (args) => {
				capturedArgs.push({ ...args });
				callCount++;
				if (callCount === 1) {
					// First call: emit 1 record (with tail) then error
					return new FakeReadSession({
						records,
						errorAfterRecords: 1,
						error: new S2Error({ message: "transient error", status: 500 }),
						tail,
					});
				}
				// Second call: succeed
				return new FakeReadSession({ records: [] });
			},
			{ wait: 10 }, // Wait up to 10 seconds
			{ minBaseDelayMillis: 1, maxBaseDelayMillis: 1, maxAttempts: 2 },
		);

		// Consume all records
		const results: SDKReadRecord<"string">[] = [];
		for await (const record of session) {
			results.push(record);
		}

		// Verify we got the record (transport explicitly emits it as success before error)
		expect(results).toHaveLength(1);

		// Verify retry adjusted wait: should be less than original 10 seconds
		expect(capturedArgs).toHaveLength(2);
		expect(capturedArgs[0]?.wait).toBe(10);
		// Should be less than original 10 seconds (since some time elapsed)
		expect(capturedArgs[1]?.wait).toBeLessThan(10);
		expect(capturedArgs[1]?.wait).toBeGreaterThanOrEqual(0);
	});

	it("adjusts seq_num to resume from next position on retry", async () => {
		const records: InternalReadRecord<"string">[] = [
			{ seq_num: 100, timestamp: 0, body: "a" },
			{ seq_num: 101, timestamp: 0, body: "b" },
			{ seq_num: 102, timestamp: 0, body: "c" },
		];

		let callCount = 0;
		const capturedArgs: Array<ReadArgs<"string">> = [];

		const session = await RetryReadSession.create(
			async (args) => {
				capturedArgs.push({ ...args });
				callCount++;
				if (callCount === 1) {
					// First call: emit 3 records (seq_num 100-102) then error
					return new FakeReadSession({
						records,
						errorAfterRecords: 3,
						error: new S2Error({ message: "transient error", status: 500 }),
					});
				}
				// Second call: succeed
				return new FakeReadSession({ records: [] });
			},
			{ seq_num: 100 }, // Start from seq_num 100
			{ minBaseDelayMillis: 1, maxBaseDelayMillis: 1, maxAttempts: 2 },
		);

		// Consume all records (including through retry)
		const results: SDKReadRecord<"string">[] = [];
		for await (const record of session) {
			results.push(record);
		}

		// Verify we got all 3 records (transport explicitly emits them as success before error)
		expect(results).toHaveLength(3);

		// Verify retry adjusted seq_num to 103 (102 + 1)
		expect(capturedArgs).toHaveLength(2);
		expect(capturedArgs[0]?.seq_num).toBe(100);
		expect(capturedArgs[1]?.seq_num).toBe(103);
	});

	it("does not adjust until parameter on retry (absolute boundary)", async () => {
		const records: InternalReadRecord<"string">[] = [
			{ seq_num: 0, timestamp: 0, body: "a" },
			{ seq_num: 1, timestamp: 0, body: "b" },
		];

		let callCount = 0;
		const capturedArgs: Array<ReadArgs<"string">> = [];

		const session = await RetryReadSession.create(
			async (args) => {
				capturedArgs.push({ ...args });
				callCount++;
				if (callCount === 1) {
					// First call: emit 2 records then error
					return new FakeReadSession({
						records,
						errorAfterRecords: 2,
						error: new S2Error({ message: "transient error", status: 500 }),
					});
				}
				// Second call: succeed
				return new FakeReadSession({ records: [] });
			},
			{ until: 1000 }, // Read until seq_num 1000
			{ minBaseDelayMillis: 1, maxBaseDelayMillis: 1, maxAttempts: 2 },
		);

		// Consume all records
		const results: SDKReadRecord<"string">[] = [];
		for await (const record of session) {
			results.push(record);
		}

		// Verify we got both records (transport explicitly emits them as success before error)
		expect(results).toHaveLength(2);

		// Verify until remains unchanged (it's an absolute boundary)
		expect(capturedArgs).toHaveLength(2);
		expect(capturedArgs[0]?.until).toBe(1000);
		expect(capturedArgs[1]?.until).toBe(1000);
	});

	it("combines all parameter adjustments on retry", async () => {
		const tail: StreamPosition = { seq_num: 100, timestamp: 0 };
		const records: InternalReadRecord<"string">[] = [
			{ seq_num: 50, timestamp: 0, body: "x".repeat(42) },
			{ seq_num: 51, timestamp: 0, body: "y".repeat(42) },
		];

		let callCount = 0;
		const capturedArgs: Array<ReadArgs<"string">> = [];

		const session = await RetryReadSession.create(
			async (args) => {
				capturedArgs.push({ ...args });
				callCount++;
				if (callCount === 1) {
					// First call: emit 2 records (with tail) then error
					return new FakeReadSession({
						records,
						errorAfterRecords: 2,
						error: new S2Error({ message: "transient error", status: 500 }),
						tail,
					});
				}
				// Second call: succeed
				return new FakeReadSession({ records: [] });
			},
			{
				seq_num: 50,
				count: 10,
				bytes: 500,
				wait: 30,
				until: 1000,
			},
			{ minBaseDelayMillis: 1, maxBaseDelayMillis: 1, maxAttempts: 2 },
		);

		// Consume all records
		const results: SDKReadRecord<"string">[] = [];
		for await (const record of session) {
			results.push(record);
		}

		// Verify we got both records (transport explicitly emits them as success before error)
		expect(results).toHaveLength(2);

		// Verify all adjustments
		expect(capturedArgs).toHaveLength(2);
		const firstArgs = capturedArgs[0]!;
		const secondArgs = capturedArgs[1]!;

		// Original args
		expect(firstArgs.seq_num).toBe(50);
		expect(firstArgs.count).toBe(10);
		expect(firstArgs.bytes).toBe(500);
		expect(firstArgs.wait).toBe(30);
		expect(firstArgs.until).toBe(1000);

		// Adjusted args
		expect(secondArgs.seq_num).toBe(52); // 50 + 2 (read 2 records)
		expect(secondArgs.count).toBe(8); // 10 - 2
		expect(secondArgs.bytes).toBeLessThan(500); // Decremented by ~100
		expect(secondArgs.bytes).toBeGreaterThan(350); // Should be around 400
		expect(secondArgs.wait).toBeLessThan(30); // Decremented by elapsed time
		expect(secondArgs.until).toBe(1000); // Unchanged (absolute boundary)
	});

	it("fails after max retry attempts exhausted", async () => {
		let callCount = 0;

		const session = await RetryReadSession.create(
			async (_args) => {
				callCount++;
				// Always error immediately without emitting any successful records
				return new FakeReadSession({
					records: [],
					errorAfterRecords: 0,
					error: new S2Error({ message: "persistent error", status: 500 }),
				});
			},
			{ count: 10 },
			{ minBaseDelayMillis: 1, maxBaseDelayMillis: 1, maxAttempts: 3 }, // Allow 2 retries
		);

		// Try to consume the stream - should fail after exhausting retries
		await expect(async () => {
			for await (const _record of session) {
				// Should eventually fail
			}
		}).rejects.toMatchObject({
			message: expect.stringContaining("persistent error"),
		});

		// Should have tried 3 times (initial + 2 retries)
		expect(callCount).toBe(3);
	});

	it("does not double-subtract count across multiple retries", async () => {
		// First attempt emits 30 then errors, second emits 40 then errors, third succeeds
		const records1: InternalReadRecord<"string">[] = Array.from(
			{ length: 30 },
			(_, i) => ({ seq_num: i, timestamp: 0, body: "a" }),
		);
		const records2: InternalReadRecord<"string">[] = Array.from(
			{ length: 40 },
			(_, i) => ({ seq_num: 30 + i, timestamp: 0, body: "b" }),
		);

		let call = 0;
		const capturedArgs: Array<ReadArgs<"string">> = [];

		const session = await RetryReadSession.create(
			async (args) => {
				capturedArgs.push({ ...args });
				call++;
				if (call === 1) {
					// First call: 30 records then error
					return new FakeReadSession({
						records: records1,
						errorAfterRecords: 30,
						error: new S2Error({ message: "transient", status: 500 }),
					});
				} else if (call === 2) {
					// Second call: 40 records then error
					return new FakeReadSession({
						records: records2,
						errorAfterRecords: 40,
						error: new S2Error({ message: "transient", status: 500 }),
					});
				}
				// Third call: success (no more records to emit; just close)
				return new FakeReadSession({ records: [] });
			},
			{ seq_num: 0, count: 100 },
			{ minBaseDelayMillis: 1, maxBaseDelayMillis: 1, maxAttempts: 3 },
		);

		// Drain the session
		for await (const _ of session) {
			// consuming until completion
		}

		// Expect args progression: 100 -> 70 -> 30
		expect(capturedArgs).toHaveLength(3);
		expect(capturedArgs[0]?.count).toBe(100);
		expect(capturedArgs[1]?.count).toBe(70); // 100 - 30
		expect(capturedArgs[2]?.count).toBe(30); // 100 - (30 + 40)
	});

	it("filters command records when ignore_command_records is set", async () => {
		const records: InternalReadRecord<"string">[] = [
			{ seq_num: 0, timestamp: 0, body: "data" },
			{
				seq_num: 1,
				timestamp: 0,
				body: "fence-token",
				headers: [["", "fence"]],
			},
			{ seq_num: 2, timestamp: 0, body: "more data" },
		];

		const session = await RetryReadSession.create(
			async (_args) => {
				return new FakeReadSession({ records });
			},
			{ ignore_command_records: true },
			{ minBaseDelayMillis: 1, maxBaseDelayMillis: 1, maxAttempts: 1 },
		);

		const results: SDKReadRecord<"string">[] = [];
		for await (const record of session) {
			results.push(record);
		}

		expect(results).toHaveLength(2);
		expect(results[0]!.seqNum).toBe(0);
		expect(results[1]!.seqNum).toBe(2);
	});

	it("defaults undefined body to empty string for string format reads", async () => {
		const records: InternalReadRecord<"string">[] = [
			{ seq_num: 0, timestamp: 1000 },
			{ seq_num: 1, timestamp: 1000, body: undefined },
		];

		const session = await RetryReadSession.create(
			async (_args) => {
				return new FakeReadSession({ records });
			},
			{ as: "string" },
			{ minBaseDelayMillis: 1, maxBaseDelayMillis: 1, maxAttempts: 1 },
		);

		const results: SDKReadRecord<"string">[] = [];
		for await (const record of session) {
			results.push(record);
		}

		expect(results).toHaveLength(2);
		expect(results[0]!.body).toBe("");
		expect(typeof results[0]!.body).toBe("string");
		expect(results[1]!.body).toBe("");
		expect(typeof results[1]!.body).toBe("string");
	});

	it("defaults undefined body to empty Uint8Array for bytes format reads", async () => {
		const records: InternalReadRecord<"bytes">[] = [
			{ seq_num: 0, timestamp: 1000 },
			{ seq_num: 1, timestamp: 1000, body: undefined },
		];

		const session = await RetryReadSession.create(
			async (_args) => {
				return new FakeReadSession<"bytes">({ records });
			},
			{ as: "bytes" },
			{ minBaseDelayMillis: 1, maxBaseDelayMillis: 1, maxAttempts: 1 },
		);

		const results: SDKReadRecord<"bytes">[] = [];
		for await (const record of session) {
			results.push(record);
		}

		expect(results).toHaveLength(2);
		expect(results[0]!.body).toBeInstanceOf(Uint8Array);
		expect(results[0]!.body.length).toBe(0);
		expect(results[1]!.body).toBeInstanceOf(Uint8Array);
		expect(results[1]!.body.length).toBe(0);
	});

	it("does not filter command records when ignore_command_records is not set", async () => {
		const records: InternalReadRecord<"string">[] = [
			{ seq_num: 0, timestamp: 0, body: "data" },
			{
				seq_num: 1,
				timestamp: 0,
				body: "fence-token",
				headers: [["", "fence"]],
			},
			{ seq_num: 2, timestamp: 0, body: "more data" },
		];

		const session = await RetryReadSession.create(
			async (_args) => {
				return new FakeReadSession({ records });
			},
			{},
			{ minBaseDelayMillis: 1, maxBaseDelayMillis: 1, maxAttempts: 1 },
		);

		const results: SDKReadRecord<"string">[] = [];
		for await (const record of session) {
			results.push(record);
		}

		expect(results).toHaveLength(3);
	});
});
