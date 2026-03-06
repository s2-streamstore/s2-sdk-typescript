import { describe, expect, it } from "vitest";
import { S2Error } from "../../error.js";
import { AppendInput, AppendRecord } from "../../types.js";

describe("Issue #143: numeric input validation", () => {
	describe("AppendRecord.trim", () => {
		it("throws S2Error for NaN seqNum", () => {
			expect(() => AppendRecord.trim(NaN)).toThrow(S2Error);
		});

		it("throws S2Error for Infinity seqNum", () => {
			expect(() => AppendRecord.trim(Infinity)).toThrow(S2Error);
		});

		it("throws S2Error for negative seqNum", () => {
			expect(() => AppendRecord.trim(-1)).toThrow(S2Error);
		});

		it("throws S2Error for non-integer seqNum", () => {
			expect(() => AppendRecord.trim(100.5)).toThrow(S2Error);
		});

		it("accepts valid non-negative integer seqNum", () => {
			const record = AppendRecord.trim(0);
			expect(record.body).toBeInstanceOf(Uint8Array);
			const record2 = AppendRecord.trim(42);
			expect(record2.body).toBeInstanceOf(Uint8Array);
		});
	});

	describe("AppendInput.create matchSeqNum", () => {
		const validRecord = AppendRecord.string({ body: "test" });

		it("throws S2Error for NaN matchSeqNum", () => {
			expect(() =>
				AppendInput.create([validRecord], { matchSeqNum: NaN }),
			).toThrow(S2Error);
		});

		it("throws S2Error for Infinity matchSeqNum", () => {
			expect(() =>
				AppendInput.create([validRecord], { matchSeqNum: Infinity }),
			).toThrow(S2Error);
		});

		it("throws S2Error for negative matchSeqNum", () => {
			expect(() =>
				AppendInput.create([validRecord], { matchSeqNum: -1 }),
			).toThrow(S2Error);
		});

		it("throws S2Error for non-integer matchSeqNum", () => {
			expect(() =>
				AppendInput.create([validRecord], { matchSeqNum: 3.14 }),
			).toThrow(S2Error);
		});

		it("accepts valid non-negative integer matchSeqNum", () => {
			const input = AppendInput.create([validRecord], { matchSeqNum: 0 });
			expect(input.matchSeqNum).toBe(0);
			const input2 = AppendInput.create([validRecord], { matchSeqNum: 42 });
			expect(input2.matchSeqNum).toBe(42);
		});

		it("accepts undefined matchSeqNum", () => {
			const input = AppendInput.create([validRecord]);
			expect(input.matchSeqNum).toBeUndefined();
		});
	});
});
