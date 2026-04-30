import type { S2Compression } from "../common.js";
import type { Client } from "../generated/client/types.gen.js";
import { canSetUserAgentHeader } from "./stream/runtime.js";

type ZstdSyncFn = (data: ArrayBufferView | ArrayBuffer | string) => Buffer;

interface CompressionModule {
	gzipSync: ZstdSyncFn;
	gunzipSync: ZstdSyncFn;
	zstdCompressSync?: ZstdSyncFn;
	zstdDecompressSync?: ZstdSyncFn;
}

let zlibPromise: Promise<CompressionModule> | undefined;
async function loadZlib(): Promise<CompressionModule> {
	if (!zlibPromise) {
		zlibPromise = import(
			/* webpackIgnore: true */
			/* @vite-ignore */
			"node:zlib"
		) as Promise<CompressionModule>;
	}
	return zlibPromise;
}

async function compressBody(
	data: Uint8Array,
	type: Exclude<S2Compression, "none">,
): Promise<Uint8Array> {
	const z = await loadZlib();
	if (type === "gzip") {
		return z.gzipSync(data);
	}
	if (!z.zstdCompressSync) {
		throw new Error("zstd compression requires Node.js v22.15+");
	}
	return z.zstdCompressSync(data);
}

async function decompressBody(
	data: Uint8Array,
	encoding: string,
): Promise<Uint8Array | undefined> {
	const z = await loadZlib();
	switch (encoding) {
		case "gzip":
		case "x-gzip":
			return z.gunzipSync(data);
		case "zstd":
			if (!z.zstdDecompressSync) {
				throw new Error("zstd decompression requires Node.js v22.15+");
			}
			return z.zstdDecompressSync(data);
		default:
			return undefined;
	}
}

/**
 * Install request/response interceptors on the generated client to
 * negotiate body compression on unary HTTP calls:
 *
 * - Outgoing: compresses non-empty request bodies with the configured
 *   algorithm and sets `Content-Encoding`.
 * - Incoming: advertises `Accept-Encoding` and decompresses responses
 *   whose `Content-Encoding` header is still present after fetch.
 *
 * No-op when `compression` is unset, `"none"`, or when running in a
 * browser (where `Accept-Encoding` is a forbidden header and the runtime
 * handles response decompression natively).
 */
export function installUnaryCompression(
	client: Client,
	compression: S2Compression | undefined,
): void {
	if (!compression || compression === "none") {
		return;
	}
	if (!canSetUserAgentHeader()) {
		return;
	}

	client.interceptors.request.use(async (req) => {
		const headers = new Headers(req.headers);
		if (!headers.has("accept-encoding")) {
			const z = await loadZlib();
			headers.set(
				"accept-encoding",
				z.zstdDecompressSync ? "zstd, gzip" : "gzip",
			);
		}

		let body: BodyInit | null = null;
		if (req.body) {
			const bytes = new Uint8Array(await req.arrayBuffer());
			if (bytes.byteLength > 0 && !headers.has("content-encoding")) {
				const compressed = await compressBody(bytes, compression);
				headers.set("content-encoding", compression);
				body = compressed;
			} else {
				body = bytes;
			}
		}

		return new Request(req.url, {
			method: req.method,
			headers,
			body,
			credentials: req.credentials,
			cache: req.cache,
			redirect: req.redirect,
			referrer: req.referrer,
			referrerPolicy: req.referrerPolicy,
			integrity: req.integrity,
			keepalive: req.keepalive,
			mode: req.mode,
			signal: req.signal,
		});
	});

	client.interceptors.response.use(async (response) => {
		const encoding = response.headers.get("content-encoding")?.toLowerCase();
		if (!encoding) {
			return response;
		}
		const compressed = new Uint8Array(await response.arrayBuffer());
		const decompressed = await decompressBody(compressed, encoding);
		if (!decompressed) {
			return new Response(compressed, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		}

		const headers = new Headers(response.headers);
		headers.delete("content-encoding");
		headers.delete("content-length");
		return new Response(decompressed, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	});
}
