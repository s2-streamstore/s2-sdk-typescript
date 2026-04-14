import { describe, expect, it } from "vitest";
import {
	S2SFrameParser,
	frameMessage,
} from "../../lib/stream/transport/s2s/framing.js";

/**
 * Issue #182: A zero-length frame (3-byte length prefix encoding 0) causes
 * the S2SFrameParser to desynchronize its internal buffer.
 *
 * The S2S protocol requires length >= 1 because the flag byte is mandatory.
 * When length=0 is received, the parser:
 *   - Reads buffer[3] as a flag even though length says there's no payload
 *   - Slices body with an invalid range (slice(4, 3) → empty)
 *   - Advances by only 3 bytes instead of 4, leaving the flag byte behind
 *   - Subsequent frames are misaligned and parse incorrectly
 *
 * The fix validates length >= 1 before reading the flag byte.
 */

describe("Issue #182: zero-length frame desynchronizes S2S parser", () => {
	it("rejects a frame with length=0", () => {
		const parser = new S2SFrameParser();

		// Construct a zero-length frame: 3-byte length prefix encoding 0, then a
		// byte that would be misinterpreted as a flag
		const zeroLengthFrame = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
		parser.push(zeroLengthFrame);

		// Before fix: parseFrame() would return a frame (with empty body) and
		// corrupt the buffer. After fix: it should throw an error.
		expect(() => parser.parseFrame()).toThrow();
	});

	it("does not desynchronize subsequent frames after a zero-length frame", () => {
		const parser = new S2SFrameParser();

		// Push a zero-length frame followed by a valid frame
		const zeroLengthFrame = new Uint8Array([0x00, 0x00, 0x00]);
		const validFrame = frameMessage({
			terminal: false,
			body: new Uint8Array([0x01, 0x02, 0x03]),
		});

		const combined = new Uint8Array(
			zeroLengthFrame.length + validFrame.length,
		);
		combined.set(zeroLengthFrame, 0);
		combined.set(validFrame, zeroLengthFrame.length);
		parser.push(combined);

		// The parser should throw on the zero-length frame rather than silently
		// consuming it and misaligning subsequent reads
		expect(() => parser.parseFrame()).toThrow();
	});

	it("parses valid frames correctly (sanity check)", () => {
		const parser = new S2SFrameParser();
		const body = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

		const frame = frameMessage({
			terminal: false,
			body,
		});
		parser.push(frame);

		const parsed = parser.parseFrame();
		expect(parsed).not.toBeNull();
		expect(parsed!.terminal).toBe(false);
		expect(parsed!.body).toEqual(body);
	});

	it("frameMessage always produces length >= 1", () => {
		// The sender side always produces valid frames (length = 1 + body.length)
		const frame = frameMessage({
			terminal: false,
			body: new Uint8Array(0),
		});

		// 3-byte length prefix should encode at least 1
		const length = (frame[0]! << 16) | (frame[1]! << 8) | frame[2]!;
		expect(length).toBeGreaterThanOrEqual(1);
	});
});
