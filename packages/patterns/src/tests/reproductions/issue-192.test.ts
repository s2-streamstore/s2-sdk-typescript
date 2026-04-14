import { describe, expect, it } from "vitest";
import {
	FrameAssembler,
	makeFrameHeaders,
} from "../../patterns/framing.js";

/**
 * Issue #192: FrameAssembler.push() throws an unhandled RangeError when a
 * record's body exceeds the remaining buffer space allocated from frame headers.
 *
 * The assembler allocates a buffer based on the declared `_frame_bytes` header,
 * but writes record bodies via `Uint8Array#set()` without checking bounds.
 * If the body is larger than the remaining space, `set()` throws RangeError.
 *
 * The assembler already drops malformed frames gracefully in other cases
 * (incomplete frames at new boundaries, byte mismatches at frame end), so
 * overflow should be handled consistently by resetting instead of crashing.
 */

describe("Issue #192: FrameAssembler should not crash on oversized record bodies", () => {
	it("does not throw when a single-record frame body exceeds declared _frame_bytes", () => {
		const assembler = new FrameAssembler();

		// Declare a frame of 4 bytes / 1 record, but send a 10-byte body
		const headers = makeFrameHeaders(4, 1);
		const body = new Uint8Array(10).fill(0xab);

		expect(() => {
			assembler.push({ headers, body });
		}).not.toThrow();
	});

	it("drops the malformed frame and returns no completed frames", () => {
		const assembler = new FrameAssembler();

		const headers = makeFrameHeaders(4, 1);
		const body = new Uint8Array(10).fill(0xab);

		const completed = assembler.push({ headers, body });
		expect(completed).toEqual([]);
	});

	it("recovers and assembles a valid frame after dropping an oversized one", () => {
		const assembler = new FrameAssembler();

		// First: malformed frame (body too large for declared size)
		const badHeaders = makeFrameHeaders(2, 1);
		const badBody = new Uint8Array(8).fill(0xff);
		const bad = assembler.push({ headers: badHeaders, body: badBody });
		expect(bad).toEqual([]);

		// Second: valid frame
		const payload = new Uint8Array([1, 2, 3, 4]);
		const goodHeaders = makeFrameHeaders(4, 1);
		const good = assembler.push({ headers: goodHeaders, body: payload });

		expect(good).toHaveLength(1);
		expect(good[0].payload).toEqual(payload);
		expect(good[0].meta).toEqual({ bytes: 4, records: 1 });
	});

	it("does not throw when a multi-record frame has an oversized continuation record", () => {
		const assembler = new FrameAssembler();

		// Declare a frame of 4 bytes across 2 records
		const headers = makeFrameHeaders(4, 2);
		const firstBody = new Uint8Array([0x01, 0x02]); // 2 bytes, fits

		// First record is fine
		const result1 = assembler.push({ headers, body: firstBody });
		expect(result1).toEqual([]);

		// Second record overflows: 2 bytes remaining, but body is 5 bytes
		const oversizedBody = new Uint8Array(5).fill(0xcc);
		expect(() => {
			assembler.push({ body: oversizedBody });
		}).not.toThrow();

		// Frame should be dropped
		const result2 = assembler.push({ body: oversizedBody });
		expect(result2).toEqual([]);
	});

	it("recovers after a multi-record overflow", () => {
		const assembler = new FrameAssembler();

		// Malformed multi-record frame: declare 3 bytes / 2 records
		const badHeaders = makeFrameHeaders(3, 2);
		assembler.push({ headers: badHeaders, body: new Uint8Array([0x01]) }); // 1 byte, fits
		assembler.push({ body: new Uint8Array(10).fill(0xee) }); // overflow

		// Now push a valid single-record frame
		const payload = new Uint8Array([0xaa, 0xbb]);
		const goodHeaders = makeFrameHeaders(2, 1);
		const result = assembler.push({ headers: goodHeaders, body: payload });

		expect(result).toHaveLength(1);
		expect(result[0].payload).toEqual(payload);
	});
});
