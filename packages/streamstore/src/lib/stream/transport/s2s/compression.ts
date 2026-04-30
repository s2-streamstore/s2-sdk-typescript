import type { InputType } from "node:zlib";
import {
	type CompressionType,
	MAX_DECOMPRESSED_PAYLOAD_BYTES,
	MAX_FRAME_PAYLOAD_BYTES,
} from "./framing.js";

type CompressionOptions = { maxOutputLength?: number };
type CompressionSyncFn = (
	data: InputType,
	options?: CompressionOptions,
) => Buffer;

interface CompressionModule {
	gzipSync: CompressionSyncFn;
	gunzipSync: CompressionSyncFn;
	zstdCompressSync?: CompressionSyncFn;
	zstdDecompressSync?: CompressionSyncFn;
}

const nodeZlibSpecifier = "node:zlib";
let zlibModule: CompressionModule | undefined;
let zlibPromise: Promise<CompressionModule> | undefined;

async function loadZlib(): Promise<CompressionModule> {
	if (!zlibPromise) {
		zlibPromise = import(
			/* webpackIgnore: true */
			/* @vite-ignore */
			nodeZlibSpecifier
		).then((mod) => {
			zlibModule = mod as CompressionModule;
			return zlibModule;
		});
	}
	return zlibPromise;
}

function getLoadedZlib(): CompressionModule {
	if (!zlibModule) {
		throw new Error("zlib module has not been loaded");
	}
	return zlibModule;
}

export async function assertCompressionSupported(
	type: CompressionType,
): Promise<void> {
	if (type === "none") {
		return;
	}
	const z = await loadZlib();
	if (type === "zstd" && (!z.zstdCompressSync || !z.zstdDecompressSync)) {
		throw new Error(
			"zstd compression requires Node.js v22.15+ (zlib zstd APIs are unavailable in this runtime)",
		);
	}
}

/**
 * Build the `Accept-Encoding` header value advertising algorithms the client
 * can decode. Returns `undefined` when no compression is configured.
 */
export function acceptEncodingHeader(
	compression: CompressionType,
): Promise<string | undefined> {
	if (compression === "none") {
		return Promise.resolve(undefined);
	}
	return Promise.resolve(compression);
}

function assertDecompressedPayloadSize(body: Uint8Array): void {
	if (body.byteLength > MAX_DECOMPRESSED_PAYLOAD_BYTES) {
		throw new Error("payload exceeds decompressed limit");
	}
}

function assertCompressedPayloadSize(body: Uint8Array): void {
	if (body.byteLength > MAX_FRAME_PAYLOAD_BYTES) {
		throw new Error("compressed payload exceeds frame limit");
	}
}

export async function compressFrameBody(
	body: Uint8Array,
	type: CompressionType,
): Promise<Uint8Array> {
	assertDecompressedPayloadSize(body);
	switch (type) {
		case "none":
			return body;
		case "gzip":
			return assertAndReturnCompressed((await loadZlib()).gzipSync(body));
		case "zstd": {
			const z = await loadZlib();
			if (!z.zstdCompressSync) {
				throw new Error("zstd compression requires Node.js v22.15+");
			}
			return assertAndReturnCompressed(z.zstdCompressSync(body));
		}
	}
}

function assertAndReturnCompressed(body: Uint8Array): Uint8Array {
	assertCompressedPayloadSize(body);
	return body;
}

export function decompressFrameBody(
	body: Uint8Array,
	type: CompressionType,
): Uint8Array {
	switch (type) {
		case "none": {
			assertDecompressedPayloadSize(body);
			return body;
		}
		case "gzip":
			return getLoadedZlib().gunzipSync(body, {
				maxOutputLength: MAX_DECOMPRESSED_PAYLOAD_BYTES,
			});
		case "zstd": {
			const z = getLoadedZlib();
			if (!z.zstdDecompressSync) {
				throw new Error("zstd decompression requires Node.js v22.15+");
			}
			return z.zstdDecompressSync(body, {
				maxOutputLength: MAX_DECOMPRESSED_PAYLOAD_BYTES,
			});
		}
	}
}
