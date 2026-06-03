import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_MAX_FRAME_BYTES,
	FrameAssembler,
	makeFrameHeaders,
} from "../../patterns/framing.js";

/**
 * Issue #230: an untrusted `_frame_bytes` header could trigger reader OOM,
 * since `FrameAssembler` sized its buffer straight from it. The fix drops
 * frames whose declared size is non-positive or over `maxFrameBytes`.
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
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drops a frame declaring more than the default max without allocating", () => {
		const assembler = new FrameAssembler();
		// 54-byte record declaring a 100 MiB frame.
		const frames = assembler.push(
			frameRecord(DEFAULT_MAX_FRAME_BYTES + 1, 1, new Uint8Array(4)),
		);

		// Frame is dropped: nothing completes, and no buffer was retained for the
		// follow-up body record to write into.
		expect(frames).toEqual([]);
		const more = assembler.push({ body: new Uint8Array(4) });
		expect(more).toEqual([]);

		// The drop is logged, not silent.
		expect(errorSpy).toHaveBeenCalledOnce();
	});

	it("drops a frame declaring zero bytes", () => {
		const assembler = new FrameAssembler();
		expect(assembler.push(frameRecord(0, 1, new Uint8Array(0)))).toEqual([]);
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
		// Over the custom limit -> dropped.
		expect(assembler.push(frameRecord(9, 1, new Uint8Array(4)))).toEqual([]);

		// Within the custom limit -> assembled.
		const payload = new Uint8Array([1, 2, 3, 4]);
		const frames = assembler.push(frameRecord(4, 1, payload));
		expect(frames).toHaveLength(1);
		expect(frames[0]!.payload).toEqual(payload);
	});
});
