import { describe, expect, it } from "vitest";
import { S2Error } from "../../error.js";
import { AppendInput, AppendRecord } from "../../types.js";

/**
 * Issue #325: Non-finite timestamps crash protobuf (S2S) append serialization.
 *
 * AppendRecord.string(), bytes(), fence(), and trim() accept timestamp values
 * that cause BigInt(NaN) / BigInt(Infinity) to throw a RangeError deep inside
 * the transport layer, far from the factory call site.
 *
 * The fix adds Number.isFinite() validation so non-finite timestamps are
 * rejected upfront with a descriptive S2Error.
 */

describe(" Non-finite timestamps should be rejected", () => {
	describe("AppendRecord.string()", () => {
		it("rejects NaN timestamp", () => {
			expect(() =>
				AppendRecord.string({ body: "hello", timestamp: NaN }),
			).toThrow(S2Error);
		});

		it("rejects Infinity timestamp", () => {
			expect(() =>
				AppendRecord.string({ body: "hello", timestamp: Infinity }),
			).toThrow(S2Error);
		});

		it("rejects -Infinity timestamp", () => {
			expect(() =>
				AppendRecord.string({ body: "hello", timestamp: -Infinity }),
			).toThrow(S2Error);
		});

		it("rejects invalid Date object", () => {
			expect(() =>
				AppendRecord.string({
					body: "hello",
					timestamp: new Date("invalid"),
				}),
			).toThrow(S2Error);
		});

		it("accepts valid numeric timestamp", () => {
			expect(() =>
				AppendRecord.string({ body: "hello", timestamp: 1234567890 }),
			).not.toThrow();
		});

		it("accepts valid Date timestamp", () => {
			expect(() =>
				AppendRecord.string({
					body: "hello",
					timestamp: new Date(),
				}),
			).not.toThrow();
		});

		it("accepts undefined timestamp", () => {
			expect(() => AppendRecord.string({ body: "hello" })).not.toThrow();
		});
	});

	describe("AppendRecord.bytes()", () => {
		it("rejects NaN timestamp", () => {
			expect(() =>
				AppendRecord.bytes({
					body: new Uint8Array([1]),
					timestamp: NaN,
				}),
			).toThrow(S2Error);
		});

		it("rejects Infinity timestamp", () => {
			expect(() =>
				AppendRecord.bytes({
					body: new Uint8Array([1]),
					timestamp: Infinity,
				}),
			).toThrow(S2Error);
		});

		it("rejects -Infinity timestamp", () => {
			expect(() =>
				AppendRecord.bytes({
					body: new Uint8Array([1]),
					timestamp: -Infinity,
				}),
			).toThrow(S2Error);
		});

		it("rejects invalid Date object", () => {
			expect(() =>
				AppendRecord.bytes({
					body: new Uint8Array([1]),
					timestamp: new Date("invalid"),
				}),
			).toThrow(S2Error);
		});

		it("accepts valid numeric timestamp", () => {
			expect(() =>
				AppendRecord.bytes({
					body: new Uint8Array([1]),
					timestamp: 1234567890,
				}),
			).not.toThrow();
		});
	});

	describe("AppendRecord.fence()", () => {
		it("rejects NaN timestamp", () => {
			expect(() => AppendRecord.fence("tok", NaN)).toThrow(S2Error);
		});

		it("rejects Infinity timestamp", () => {
			expect(() => AppendRecord.fence("tok", Infinity)).toThrow(S2Error);
		});

		it("rejects invalid Date object", () => {
			expect(() => AppendRecord.fence("tok", new Date("invalid"))).toThrow(
				S2Error,
			);
		});

		it("accepts valid timestamp", () => {
			expect(() => AppendRecord.fence("tok", 1234567890)).not.toThrow();
		});
	});

	describe("AppendRecord.trim()", () => {
		it("rejects NaN timestamp", () => {
			expect(() => AppendRecord.trim(0, NaN)).toThrow(S2Error);
		});

		it("rejects Infinity timestamp", () => {
			expect(() => AppendRecord.trim(0, Infinity)).toThrow(S2Error);
		});

		it("rejects invalid Date object", () => {
			expect(() => AppendRecord.trim(0, new Date("invalid"))).toThrow(S2Error);
		});

		it("accepts valid timestamp", () => {
			expect(() => AppendRecord.trim(0, 1234567890)).not.toThrow();
		});
	});

	describe("AppendInput.create()", () => {
		it("rejects records with NaN timestamp (defense-in-depth)", () => {
			// Construct a record manually to bypass factory validation
			const record = {
				body: "hello",
				headers: undefined,
				timestamp: NaN,
				meteredBytes: 10,
			} as unknown as ReturnType<typeof AppendRecord.string>;
			expect(() => AppendInput.create([record])).toThrow(S2Error);
		});

		it("rejects records with Infinity timestamp (defense-in-depth)", () => {
			const record = {
				body: new Uint8Array([1]),
				headers: undefined,
				timestamp: Infinity,
				meteredBytes: 9,
			} as unknown as ReturnType<typeof AppendRecord.bytes>;
			expect(() => AppendInput.create([record])).toThrow(S2Error);
		});

		it("rejects records with invalid Date timestamp (defense-in-depth)", () => {
			const record = {
				body: new Uint8Array([1]),
				headers: undefined,
				timestamp: new Date("invalid"),
				meteredBytes: 9,
			} as unknown as ReturnType<typeof AppendRecord.bytes>;
			expect(() => AppendInput.create([record])).toThrow(S2Error);
		});

		it("accepts records with valid timestamp", () => {
			const record = AppendRecord.string({
				body: "hello",
				timestamp: Date.now(),
			});
			expect(() => AppendInput.create([record])).not.toThrow();
		});
	});

	describe("Error message content", () => {
		it("includes descriptive message about finite timestamp", () => {
			try {
				AppendRecord.string({ body: "hello", timestamp: NaN });
				expect.fail("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(S2Error);
				expect((e as S2Error).message).toContain(
					"timestamp must be a finite number",
				);
				expect((e as S2Error).origin).toBe("sdk");
			}
		});
	});
});
