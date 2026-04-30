import * as zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	acceptEncodingHeader,
	compressFrameBody,
	decompressFrameBody,
} from "../lib/stream/transport/s2s/compression.js";
import {
	type CompressionType,
	frameMessage,
	MAX_DECOMPRESSED_PAYLOAD_BYTES,
	MAX_FRAME_BYTES,
	MAX_FRAME_PAYLOAD_BYTES,
	S2SFrameParser,
} from "../lib/stream/transport/s2s/framing.js";

const hasZstd =
	typeof (zlib as unknown as { zstdCompressSync?: unknown })
		.zstdCompressSync === "function";

const algorithms: CompressionType[] = [
	"gzip",
	...(hasZstd ? ["zstd"] : []),
] as CompressionType[];

function rawFrame(length: number, flag: number, body = new Uint8Array(0)) {
	return new Uint8Array([
		(length >> 16) & 0xff,
		(length >> 8) & 0xff,
		length & 0xff,
		flag,
		...body,
	]);
}

describe("s2s frame compression round-trip", () => {
	it.each(algorithms)("encodes and decodes %s frames", async (alg) => {
		const payload = new TextEncoder().encode(
			"the quick brown fox jumps over the lazy dog ".repeat(100),
		);

		const compressed = await compressFrameBody(payload, alg);
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

	it("passes through none compression unchanged", async () => {
		const payload = new Uint8Array([1, 2, 3, 4, 5]);
		expect(await compressFrameBody(payload, "none")).toBe(payload);
		expect(decompressFrameBody(payload, "none")).toBe(payload);
	});

	it("advertises only the configured response compression", async () => {
		expect(await acceptEncodingHeader("none")).toBeUndefined();
		expect(await acceptEncodingHeader("gzip")).toBe("gzip");
		expect(await acceptEncodingHeader("zstd")).toBe("zstd");
	});

	it.each(algorithms)(
		"keeps terminal frames plaintext when %s is requested",
		async (alg) => {
			const payload = new TextEncoder().encode(
				JSON.stringify({ code: "BAD_REQUEST", message: "plain error" }),
			);
			const frame = frameMessage({
				terminal: true,
				statusCode: 400,
				compression: alg,
				body: payload,
			});

			const parser = new S2SFrameParser();
			parser.push(frame);
			const parsed = parser.parseFrame();
			expect(parsed).not.toBeNull();
			expect(parsed?.terminal).toBe(true);
			expect(parsed?.statusCode).toBe(400);
			expect(parsed?.compression).toBe("none");

			expect(JSON.parse(new TextDecoder().decode(parsed!.body))).toEqual({
				code: "BAD_REQUEST",
				message: "plain error",
			});
		},
	);

	it("enforces the 2 MiB frame encode limit", () => {
		expect(() =>
			frameMessage({
				terminal: false,
				body: new Uint8Array(MAX_FRAME_PAYLOAD_BYTES),
			}),
		).not.toThrow();

		expect(() =>
			frameMessage({
				terminal: false,
				body: new Uint8Array(MAX_FRAME_PAYLOAD_BYTES + 1),
			}),
		).toThrow("Message too large");
	});

	it("rejects frames over the 2 MiB decode limit", () => {
		const parser = new S2SFrameParser();
		parser.push(rawFrame(MAX_FRAME_BYTES + 1, 0));
		expect(() => parser.parseFrame()).toThrow("frame exceeds decode limit");
	});

	it("rejects unknown compression bits", () => {
		const parser = new S2SFrameParser();
		parser.push(rawFrame(1, 0x60));
		expect(() => parser.parseFrame()).toThrow("unknown compression algorithm");
	});

	it("rejects terminal frames missing a status code", () => {
		const parser = new S2SFrameParser();
		parser.push(rawFrame(1, 0x80));
		expect(() => parser.parseFrame()).toThrow(
			"terminal message missing status code",
		);
	});

	it("rejects decompressed payloads over the 2 MiB payload limit", async () => {
		await compressFrameBody(new Uint8Array(1024), "gzip");
		const oversized = new Uint8Array(MAX_DECOMPRESSED_PAYLOAD_BYTES + 1);
		const compressed = zlib.gzipSync(oversized);

		expect(() => decompressFrameBody(compressed, "gzip")).toThrow();
	});
});
