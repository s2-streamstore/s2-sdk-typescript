import { AppendHeaders, AppendRecord, meteredBytes } from "@s2-dev/streamstore";

import {
	DEDUPE_SEQ_HEADER_BYTES,
	DEDUPE_WRITER_UNIQ_ID,
	FRAME_BYTES_HEADER_BYTES,
	FRAME_RECORDS_HEADER_BYTES,
} from "./constants.js";

/**
 * Maximum allowed size for a single AppendRecord on S2, in bytes.
 *
 * This is currently 1 MiB; the exact number should match the S2 service limit.
 */
export const MAX_RECORD_BYTES = 1024 * 1024;

/**
 * Compute the worst-case header overhead for a framed, deduped record.
 *
 * We assume:
 * - binary format headers (Uint8Array keys/values)
 * - four headers: frame_bytes, frame_records, dedupe_seq, writer_id
 *
 * This uses the SDK's meteredBytes implementation so it stays correct if
 * the sizing rules ever change.
 */
function computeOverheads(): {
	baseOverheadBytes: number;
	frameHeaderOverheadBytes: number;
} {
	const empty = AppendRecord.bytes({ body: new Uint8Array(0) });

	const headers: AppendHeaders<"bytes"> = [
		[FRAME_RECORDS_HEADER_BYTES, new Uint8Array(8)],
		[FRAME_BYTES_HEADER_BYTES, new Uint8Array(8)],
		[DEDUPE_SEQ_HEADER_BYTES, new Uint8Array(8)],
		[DEDUPE_WRITER_UNIQ_ID, new Uint8Array(12)], // 12 bytes for nanoid(12)
	];

	const withHeaders = AppendRecord.bytes({ body: new Uint8Array(0), headers });

	const baseOverheadBytes = meteredBytes(empty);
	const frameHeaderOverheadBytes =
		meteredBytes(withHeaders) - baseOverheadBytes;

	return { baseOverheadBytes, frameHeaderOverheadBytes };
}

const {
	baseOverheadBytes: BASE_OVERHEAD_BYTES,
	frameHeaderOverheadBytes: FRAME_HEADER_OVERHEAD_BYTES,
} = computeOverheads();

/**
 * Maximum number of body bytes we allow in a single record that may carry
 * frame + dedupe headers without exceeding MAX_RECORD_BYTES.
 *
 * Non-first chunks, which carry fewer headers, will always be under the limit
 * if they respect this size.
 */
export const MAX_CHUNK_BODY_BYTES =
	MAX_RECORD_BYTES - BASE_OVERHEAD_BYTES - FRAME_HEADER_OVERHEAD_BYTES;

/**
 * Split a Uint8Array into chunks, each with body length <= maxChunkSize.
 */
export function chunkBytes(
	data: Uint8Array,
	maxChunkSize: number = MAX_CHUNK_BODY_BYTES,
): Uint8Array[] {
	if (maxChunkSize <= 0) {
		throw new Error("maxChunkSize must be positive");
	}

	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < data.length; offset += maxChunkSize) {
		chunks.push(data.subarray(offset, offset + maxChunkSize));
	}
	return chunks;
}
