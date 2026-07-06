import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_FRAME_BYTES,
	FrameAssembler,
	FrameSizeError,
	makeFrameHeaders,
} from "../../patterns/framing.js";

/**
 * Issue #230: an untrusted `_frame_bytes` header could trigger reader OOM,
 * since `FrameAssembler` sized its buffer straight from it. The fix rejects
 * frames whose declared size is non-positive or over `maxFrameBytes` with a
 * FrameSizeError before allocating (issue #272: was a silent drop).
 */

function frameRecord(
	declaredBytes: number,
	numRecords: number,
	body: Uint8Array,
) {
	return {
		headers: makeFrameHeaders(declaredBytes, numRecords) as any,
		body,
	};
}

describe("Issue #230: FrameAssembler rejects oversized declared frames", () => {
	it("throws on a frame declaring more than the default max without allocating", () => {
		const assembler = new FrameAssembler();
		// 54-byte record declaring a 100 MiB frame.
		expect(() =>
			assembler.push(
				frameRecord(DEFAULT_MAX_FRAME_BYTES + 1, 1, new Uint8Array(4)),
			),
		).toThrow(FrameSizeError);

		// No buffer was retained for a follow-up body record to write into.
		const more = assembler.push({ body: new Uint8Array(4) });
		expect(more).toEqual([]);
	});

	it("throws on a frame declaring zero bytes", () => {
		const assembler = new FrameAssembler();
		expect(() => assembler.push(frameRecord(0, 1, new Uint8Array(0)))).toThrow(
			FrameSizeError,
		);
	});

	it("still assembles a valid frame within the limit", () => {
		const assembler = new FrameAssembler();
		const payload = new TextEncoder().encode("hello");
		const frames = assembler.push(frameRecord(payload.length, 1, payload));
		expect(frames).toHaveLength(1);
		expect(frames[0]!.payload).toEqual(payload);
	});

	it("honors a custom maxFrameBytes", () => {
		const assembler = new FrameAssembler({ maxFrameBytes: 8 });
		// Over the custom limit -> rejected.
		expect(() => assembler.push(frameRecord(9, 1, new Uint8Array(4)))).toThrow(
			FrameSizeError,
		);

		// Within the custom limit -> assembled.
		const payload = new Uint8Array([1, 2, 3, 4]);
		const frames = assembler.push(frameRecord(4, 1, payload));
		expect(frames).toHaveLength(1);
		expect(frames[0]!.payload).toEqual(payload);
	});
});
