import * as zlib from "node:zlib";
import type { CompressionType } from "./framing.js";

type ZstdSyncFn = (data: zlib.InputType) => Buffer;

const zstdCompressSync = (zlib as unknown as { zstdCompressSync?: ZstdSyncFn })
	.zstdCompressSync;

const zstdDecompressSync = (
	zlib as unknown as { zstdDecompressSync?: ZstdSyncFn }
).zstdDecompressSync;

export function assertCompressionSupported(type: CompressionType): void {
	if (type === "zstd" && !zstdCompressSync) {
		throw new Error(
			"zstd compression requires Node.js v22.15+ (zlib.zstdCompressSync is unavailable in this runtime)",
		);
	}
}

/**
 * Build the `Accept-Encoding` header value advertising algorithms the client
 * can decode. Returns `undefined` when no compression is configured.
 *
 * Lists zstd before gzip to indicate preference; zstd is omitted if the
 * runtime cannot decompress it.
 */
export function acceptEncodingHeader(
	compression: CompressionType,
): string | undefined {
	if (compression === "none") {
		return undefined;
	}
	return zstdDecompressSync ? "zstd, gzip" : "gzip";
}

export function compressFrameBody(
	body: Uint8Array,
	type: CompressionType,
): Uint8Array {
	switch (type) {
		case "none":
			return body;
		case "gzip":
			return zlib.gzipSync(body);
		case "zstd": {
			if (!zstdCompressSync) {
				throw new Error("zstd compression requires Node.js v22.15+");
			}
			return zstdCompressSync(body);
		}
	}
}

export function decompressFrameBody(
	body: Uint8Array,
	type: CompressionType,
): Uint8Array {
	switch (type) {
		case "none":
			return body;
		case "gzip":
			return zlib.gunzipSync(body);
		case "zstd": {
			if (!zstdDecompressSync) {
				throw new Error("zstd decompression requires Node.js v22.15+");
			}
			return zstdDecompressSync(body);
		}
	}
}
