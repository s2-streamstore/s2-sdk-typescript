import * as zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	compressFrameBody,
	decompressFrameBody,
} from "../lib/stream/transport/s2s/compression.js";
import {
	type CompressionType,
	frameMessage,
	S2SFrameParser,
} from "../lib/stream/transport/s2s/framing.js";

const hasZstd =
	typeof (zlib as unknown as { zstdCompressSync?: unknown })
		.zstdCompressSync === "function";

const algorithms: CompressionType[] = [
	"gzip",
	...(hasZstd ? ["zstd"] : []),
] as CompressionType[];

describe("s2s frame compression round-trip", () => {
	it.each(algorithms)("encodes and decodes %s frames", (alg) => {
		const payload = new TextEncoder().encode(
			"the quick brown fox jumps over the lazy dog ".repeat(100),
		);

		const compressed = compressFrameBody(payload, alg);
		expect(compressed).not.toEqual(payload);

		const frame = frameMessage({
			terminal: false,
			compression: alg,
			body: compressed,
		});

		const parser = new S2SFrameParser();
		parser.push(frame);
		const parsed = parser.parseFrame();
		expect(parsed).not.toBeNull();
		expect(parsed?.compression).toBe(alg);
		expect(parsed?.terminal).toBe(false);

		const decompressed = decompressFrameBody(parsed!.body, parsed!.compression);
		expect(new TextDecoder().decode(decompressed)).toBe(
			new TextDecoder().decode(payload),
		);
	});

	it("passes through none compression unchanged", () => {
		const payload = new Uint8Array([1, 2, 3, 4, 5]);
		expect(compressFrameBody(payload, "none")).toBe(payload);
		expect(decompressFrameBody(payload, "none")).toBe(payload);
	});
});
