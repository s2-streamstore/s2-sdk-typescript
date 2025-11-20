import type {
	AppendHeaders,
	AppendRecord,
	ReadHeaders,
} from "@s2-dev/streamstore";

import { DEDUPE_SEQ_HEADER_BYTES } from "./constants.js";
import { decodeU64, encodeU64 } from "./u64.js";

const textEncoder = new TextEncoder();

/**
 * Extract the per-record dedupe sequence number from headers, if present.
 */
export function extractDedupeSeq(
	headers?: ReadHeaders<"bytes">,
): bigint | undefined {
	if (!headers) return undefined;

	for (const [key, value] of headers) {
		if (key.length !== DEDUPE_SEQ_HEADER_BYTES.length) continue;
		let match = true;
		for (let i = 0; i < key.length; i += 1) {
			if (key[i] !== DEDUPE_SEQ_HEADER_BYTES[i]) {
				match = false;
				break;
			}
		}
		if (match) {
			return decodeU64(value);
		}
	}

	return undefined;
}

/**
 * Simple dedupe filter for a single-writer stream.
 *
 * Assumes per-record dedupe sequence numbers are monotonically increasing and
 * delivered in order. Any record with seq <= lastSeenSeq is considered a
 * duplicate and should be dropped.
 */
export class DedupeFilter {
	private lastSeenSeq: bigint | undefined;

	shouldAccept(headers?: ReadHeaders<"bytes">): boolean {
		const seq = extractDedupeSeq(headers);
		if (seq === undefined) return true;

		if (this.lastSeenSeq === undefined || seq > this.lastSeenSeq) {
			this.lastSeenSeq = seq;
			return true;
		}

		return false;
	}
}

/**
 * Inject a monotonically increasing dedupe sequence header into each record.
 *
 * Returns the next sequence number after the last record, so callers can
 * maintain state across multiple batches.
 */
export function injectDedupeHeaders(
	records: AppendRecord[],
	startSeq: bigint,
): bigint {
	let seq = startSeq;

	for (const record of records) {
		const headerValue = encodeU64(seq);
		seq += 1n;

		const existing = record.headers as
			| AppendHeaders<"string">
			| AppendHeaders<"bytes">
			| undefined;

		let headers: AppendHeaders<"bytes">;

		if (!existing) {
			headers = [[DEDUPE_SEQ_HEADER_BYTES, headerValue]];
		} else if (Array.isArray(existing)) {
			const hdrs: Array<[Uint8Array, Uint8Array]> = [];
			for (const [k, v] of existing as any) {
				const kb = typeof k === "string" ? textEncoder.encode(k) : k;
				const vb = typeof v === "string" ? textEncoder.encode(v) : v;
				hdrs.push([kb, vb]);
			}
			hdrs.push([DEDUPE_SEQ_HEADER_BYTES, headerValue]);
			headers = hdrs as AppendHeaders<"bytes">;
		} else {
			const hdrs: Array<[Uint8Array, Uint8Array]> = [];
			for (const [k, v] of Object.entries(existing as Record<string, string>)) {
				hdrs.push([textEncoder.encode(k), textEncoder.encode(v)]);
			}
			hdrs.push([DEDUPE_SEQ_HEADER_BYTES, headerValue]);
			headers = hdrs as AppendHeaders<"bytes">;
		}

		(record as any).headers = headers;
	}

	return seq;
}
