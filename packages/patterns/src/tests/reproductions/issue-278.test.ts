import { AppendRecord, S2Error } from "@s2-dev/streamstore";
import { describe, expect, it } from "vitest";
import {
	DEDUPE_SEQ_HEADER,
	DEDUPE_SEQ_HEADER_BYTES,
	WRITER_UNIQ_ID,
} from "../../patterns/constants.js";
import {
	extractDedupeSeq,
	injectDedupeHeaders,
} from "../../patterns/dedupe.js";

/**
 * Issue #278: injectDedupeHeaders appended `_dedupe_seq`/`_writer_id` without
 * checking for pre-existing ones. Since extractDedupeSeq returns the FIRST
 * match, a stale pre-existing header shadowed the injected sequence (silent
 * dedupe corruption) or crashed decodeU64 if not 8 bytes. The fix rejects
 * records that already carry a reserved dedupe header, before mutating any.
 */

describe("Issue #278: injectDedupeHeaders rejects pre-existing dedupe headers", () => {
	it("throws S2Error on an existing string _dedupe_seq header", () => {
		const record = AppendRecord.string({
			body: "hello",
			headers: [[DEDUPE_SEQ_HEADER, "stale"]],
		});
		expect(() => injectDedupeHeaders([record], "writer-a", 0)).toThrow(S2Error);
		expect(() => injectDedupeHeaders([record], "writer-a", 0)).toThrow(
			DEDUPE_SEQ_HEADER,
		);
	});

	it("throws S2Error on an existing string _writer_id header", () => {
		const record = AppendRecord.string({
			body: "hello",
			headers: [[WRITER_UNIQ_ID, "other-writer"]],
		});
		expect(() => injectDedupeHeaders([record], "writer-a", 0)).toThrow(S2Error);
	});

	it("throws S2Error on an existing bytes _dedupe_seq header (double injection)", () => {
		const record = AppendRecord.string({ body: "hello" });
		const next = injectDedupeHeaders([record], "writer-a", 7);
		expect(next).toBe(8);

		// A second injection must not stack another _dedupe_seq behind the first.
		expect(() => injectDedupeHeaders([record], "writer-a", next)).toThrow(
			S2Error,
		);
		expect(extractDedupeSeq(record.headers as any)).toEqual(["writer-a", 7]);
	});

	it("modifies no record when a later record has a collision", () => {
		const clean = AppendRecord.string({ body: "first" });
		const dirty = AppendRecord.bytes({
			body: new Uint8Array([1]),
			headers: [[DEDUPE_SEQ_HEADER_BYTES, new Uint8Array(8)]],
		});

		expect(() => injectDedupeHeaders([clean, dirty], "writer-a", 0)).toThrow(
			S2Error,
		);
		expect(extractDedupeSeq(clean.headers as any)).toBeUndefined();
	});

	it("still injects into records with unrelated headers", () => {
		const record = AppendRecord.string({
			body: "world",
			headers: [["key", "val"]],
		});
		const next = injectDedupeHeaders([record], "writer-a", 42);
		expect(next).toBe(43);
		expect(extractDedupeSeq(record.headers as any)).toEqual(["writer-a", 42]);
	});
});
