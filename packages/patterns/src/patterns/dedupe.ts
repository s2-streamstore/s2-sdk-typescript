import type {
	AppendHeaders,
	AppendRecord,
	ReadHeaders,
} from "@s2-dev/streamstore";

import { DEDUPE_SEQ_HEADER_BYTES, DEDUPE_WRITER_UNIQ_ID } from "./constants.js";
import { decodeU64, encodeU64 } from "./u64.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const LEGACY_WRITER_ID = "__legacy__";

/**
 * Extract the per-record dedupe sequence number from headers, if present.
 */
export function extractDedupeSeq(
	headers?: ReadHeaders<"bytes">,
): [string, number] | undefined {
	if (!headers) return undefined;

	let seq: bigint | undefined;
	let writerId: string | undefined;

	for (const [key, value] of headers) {
		// Extract the dedupe sequence number.
		if (!seq && key.length === DEDUPE_SEQ_HEADER_BYTES.length) {
			let match = true;
			for (let i = 0; i < key.length; i += 1) {
				if (key[i] !== DEDUPE_SEQ_HEADER_BYTES[i]) {
					match = false;
					break;
				}
			}
			if (match) {
				seq = decodeU64(value);
				if (writerId !== undefined) break;
				continue;
			}
		}

		// Extract the writer id, if present.
		if (!writerId && key.length === DEDUPE_WRITER_UNIQ_ID.length) {
			let match = true;
			for (let i = 0; i < key.length; i += 1) {
				if (key[i] !== DEDUPE_WRITER_UNIQ_ID[i]) {
					match = false;
					break;
				}
			}
			if (match) {
				writerId = textDecoder.decode(value);
				if (seq !== undefined) break;
			}
		}
	}

	if (seq === undefined) return undefined;
	return [writerId ?? LEGACY_WRITER_ID, Number(seq)];
}

/**
 * Dedupe filter for a single-writer stream with crash recovery.
 *
 * Designed for streams where only one writer is active at a time, but the
 * writer may crash and restart with a new session (and thus a new `_writer_id`).
 * When a new writer ID is seen, the filter resets its state, assuming the
 * previous writer is no longer active.
 *
 * Within a writer session, dedupe sequence numbers must be monotonically
 * increasing and delivered in order. Records with seq <= lastSeenSeq are
 * considered duplicates (from retried appends) and should be dropped.
 *
 * Note: This does not support multiple concurrent writers. If writers
 * interleave, duplicates from earlier writers may not be filtered correctly.
 */
export class DedupeFilter {
	private lastSeenSeq: number | undefined;
	private lastWriterId: string | undefined;

	shouldAccept(headers?: ReadHeaders<"bytes">): boolean {
		const result = extractDedupeSeq(headers);
		if (!result) return true;
		const [writerId, seq] = result;

		// New writerId -> start a fresh dedupe window.
		if (this.lastWriterId !== writerId) {
			this.lastWriterId = writerId;
			this.lastSeenSeq = seq;
			return true;
		}

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
	writerId: string,
	startSeq: number,
): number {
	let seq = startSeq;

	for (const record of records) {
		const headerValue = encodeU64(seq);
		seq += 1;

		const existing = record.headers as
			| AppendHeaders<"string">
			| AppendHeaders<"bytes">
			| undefined;

		let headers: AppendHeaders<"bytes">;

		if (!existing) {
			headers = [
				[DEDUPE_SEQ_HEADER_BYTES, headerValue],
				[DEDUPE_WRITER_UNIQ_ID, textEncoder.encode(writerId)],
			];
		} else {
			const hdrs: Array<[Uint8Array, Uint8Array]> = [];
			for (const [k, v] of existing as Array<
				[string | Uint8Array, string | Uint8Array]
			>) {
				const kb = typeof k === "string" ? textEncoder.encode(k) : k;
				const vb = typeof v === "string" ? textEncoder.encode(v) : v;
				hdrs.push([kb, vb]);
			}
			hdrs.push([DEDUPE_SEQ_HEADER_BYTES, headerValue]);
			hdrs.push([DEDUPE_WRITER_UNIQ_ID, textEncoder.encode(writerId)]);
			headers = hdrs as AppendHeaders<"bytes">;
		}

		(record as any).headers = headers;
	}

	return seq;
}
