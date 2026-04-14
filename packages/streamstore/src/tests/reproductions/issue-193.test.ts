import { describe, expect, it } from "vitest";
import { BatchTransform } from "../../batch-transform.js";
import { S2Error } from "../../error.js";
import { AppendRecord } from "../../types.js";

/**
 * Issue #193: NaN batch configuration bypasses validation and breaks batching.
 *
 * JavaScript comparisons with NaN always return false, so the constructor
 * range checks (e.g. `NaN < 1`, `NaN > 1000`, `NaN >= 0`) silently pass.
 * This causes:
 *  - lingerDurationMillis=NaN: timer never starts (NaN >= 0 is false)
 *  - maxBatchRecords=NaN: record limit never triggers (NaN comparisons are false)
 *  - maxBatchBytes=NaN: byte limit never triggers
 *
 * The fix adds Number.isFinite() checks so NaN/Infinity are rejected upfront.
 */

describe("Issue #193: NaN batch configuration should be rejected", () => {
	it("rejects NaN for maxBatchRecords", () => {
		expect(
			() => new BatchTransform({ maxBatchRecords: NaN }),
		).toThrow(S2Error);
	});

	it("rejects NaN for maxBatchBytes", () => {
		expect(
			() => new BatchTransform({ maxBatchBytes: NaN }),
		).toThrow(S2Error);
	});

	it("rejects NaN for lingerDurationMillis", () => {
		expect(
			() => new BatchTransform({ lingerDurationMillis: NaN }),
		).toThrow(S2Error);
	});

	it("rejects Infinity for maxBatchRecords", () => {
		expect(
			() => new BatchTransform({ maxBatchRecords: Infinity }),
		).toThrow(S2Error);
	});

	it("rejects Infinity for maxBatchBytes", () => {
		expect(
			() => new BatchTransform({ maxBatchBytes: Infinity }),
		).toThrow(S2Error);
	});

	it("rejects Infinity for lingerDurationMillis", () => {
		expect(
			() => new BatchTransform({ lingerDurationMillis: Infinity }),
		).toThrow(S2Error);
	});

	it("rejects -Infinity for lingerDurationMillis", () => {
		expect(
			() => new BatchTransform({ lingerDurationMillis: -Infinity }),
		).toThrow(S2Error);
	});

	it("NaN lingerDurationMillis would prevent timer from starting (verifies the bug)", () => {
		// Before the fix, this would NOT throw, and the linger timer would
		// never start because `NaN >= 0` is false.
		// After the fix, this throws at construction time.
		expect(
			() => new BatchTransform({ lingerDurationMillis: NaN }),
		).toThrow(/lingerDurationMillis/);
	});

	it("NaN maxBatchRecords would allow unbounded batches (verifies the bug)", async () => {
		// Before the fix, this would NOT throw, and records would accumulate
		// indefinitely because `batch.length + 1 > NaN` is always false.
		// After the fix, this throws at construction time.
		expect(
			() => new BatchTransform({ maxBatchRecords: NaN }),
		).toThrow(/maxBatchRecords/);
	});

	it("valid configuration values still work", () => {
		// Ensure the fix doesn't break valid inputs
		expect(() => new BatchTransform({ maxBatchRecords: 100 })).not.toThrow();
		expect(() => new BatchTransform({ maxBatchBytes: 512 })).not.toThrow();
		expect(
			() => new BatchTransform({ lingerDurationMillis: 0 }),
		).not.toThrow();
		expect(
			() => new BatchTransform({ lingerDurationMillis: 10 }),
		).not.toThrow();
	});
});
