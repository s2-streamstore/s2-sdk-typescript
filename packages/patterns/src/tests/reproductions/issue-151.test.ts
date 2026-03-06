import { AppendRecord, meteredBytes } from "@s2-dev/streamstore";
import { describe, expect, it } from "vitest";
import { injectDedupeHeaders } from "../../patterns/dedupe.js";

describe("issue-151: injectDedupeHeaders must update meteredBytes", () => {
	it("should recompute meteredBytes after injecting dedupe headers on a record with no existing headers", () => {
		const record = AppendRecord.string({ body: "hello" });
		const originalMeteredBytes = record.meteredBytes;

		// Before injection: meteredBytes = 8 + 2*0 + 0 + 5 = 13
		expect(originalMeteredBytes).toBe(13);

		const records = [record];
		injectDedupeHeaders(records, "w1", 0);

		// After injection: headers are added, so meteredBytes must increase
		expect(records[0].meteredBytes).toBeGreaterThan(originalMeteredBytes);

		// Verify meteredBytes matches the recalculated value
		const expected = meteredBytes(records[0]);
		expect(records[0].meteredBytes).toBe(expected);
	});

	it("should recompute meteredBytes after injecting dedupe headers on a record with existing headers", () => {
		const record = AppendRecord.string({
			body: "world",
			headers: [["key", "val"]],
		});
		const originalMeteredBytes = record.meteredBytes;

		// Before injection: meteredBytes = 8 + 2*1 + (3+3) + 5 = 21
		expect(originalMeteredBytes).toBe(21);

		const records = [record];
		injectDedupeHeaders(records, "writer-abc", 42);

		// After injection: two more headers added, so meteredBytes must increase
		expect(records[0].meteredBytes).toBeGreaterThan(originalMeteredBytes);

		// Verify meteredBytes matches the recalculated value
		const expected = meteredBytes(records[0]);
		expect(records[0].meteredBytes).toBe(expected);
	});

	it("should recompute meteredBytes for bytes records", () => {
		const body = new TextEncoder().encode("binary-body");
		const record = AppendRecord.bytes({ body });
		const originalMeteredBytes = record.meteredBytes;

		const records = [record];
		injectDedupeHeaders(records, "w2", 100);

		expect(records[0].meteredBytes).toBeGreaterThan(originalMeteredBytes);

		const expected = meteredBytes(records[0]);
		expect(records[0].meteredBytes).toBe(expected);
	});

	it("should recompute meteredBytes for all records in a batch", () => {
		const records = [
			AppendRecord.string({ body: "a" }),
			AppendRecord.string({ body: "bb" }),
			AppendRecord.string({ body: "ccc" }),
		];
		const originalSizes = records.map((r) => r.meteredBytes);

		injectDedupeHeaders(records, "batch-writer", 0);

		for (let i = 0; i < records.length; i++) {
			expect(records[i].meteredBytes).toBeGreaterThan(originalSizes[i]);
			expect(records[i].meteredBytes).toBe(meteredBytes(records[i]));
		}
	});
});
