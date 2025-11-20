import type { AppendHeaders, ReadHeaders } from "@s2-dev/streamstore";
import { AppendRecord } from "@s2-dev/streamstore";

import {
	FRAME_BYTES_HEADER_BYTES,
	FRAME_RECORDS_HEADER_BYTES,
} from "./constants.js";
import { decodeU64, encodeU64 } from "./u64.js";

/**
 * Minimal shape we rely on for both AppendRecord and ReadRecord<"bytes">.
 */
export type ByteRecord = {
	headers?: ReadHeaders<"bytes">;
	body?: Uint8Array | null;
};

export type FrameMeta = {
	bytes: number;
	records: number;
};

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

export function makeFrameHeaders(
	totalBytes: number,
	numRecords: number,
): AppendHeaders<"bytes"> {
	const headers: Array<[Uint8Array, Uint8Array]> = [
		[FRAME_RECORDS_HEADER_BYTES, encodeU64(numRecords)],
		[FRAME_BYTES_HEADER_BYTES, encodeU64(totalBytes)],
	];
	return headers;
}

export function parseFrameHeaders(
	headers: ReadHeaders<"bytes">,
): FrameMeta | undefined {
	let bytes: bigint | undefined;
	let records: bigint | undefined;

	for (const [key, value] of headers) {
		if (equalBytes(key, FRAME_BYTES_HEADER_BYTES)) {
			bytes = decodeU64(value);
		} else if (equalBytes(key, FRAME_RECORDS_HEADER_BYTES)) {
			records = decodeU64(value);
		}
	}

	if (bytes === undefined || records === undefined) {
		return undefined;
	}

	return {
		bytes: Number(bytes),
		records: Number(records),
	};
}

export type CompletedFrame = {
	payload: Uint8Array;
	meta: FrameMeta;
};

/**
 * Stateful helper that consumes byte records and yields complete frames when
 * all pieces have been received.
 */
export class FrameAssembler {
	private buffer: Uint8Array | undefined;
	private remainingRecords = 0;
	private writtenBytes = 0;
	private expectedBytes = 0;
	private currentMeta: FrameMeta | undefined;

	push(record: ByteRecord): CompletedFrame[] {
		const completed: CompletedFrame[] = [];

		const maybeMeta = record.headers
			? parseFrameHeaders(record.headers)
			: undefined;

		if (maybeMeta) {
			if (this.buffer && this.buffer.length > 0) {
				// Incomplete frame: drop existing buffered data on new frame boundary.
				this.reset();
			}
			this.buffer = new Uint8Array(maybeMeta.bytes);
			this.remainingRecords = maybeMeta.records;
			this.expectedBytes = maybeMeta.bytes;
			this.writtenBytes = 0;
			this.currentMeta = maybeMeta;
		}

		if (this.buffer && record.body) {
			this.buffer.set(record.body, this.writtenBytes);
			this.writtenBytes += record.body.length;
			this.remainingRecords -= 1;

			if (this.remainingRecords === 0) {
				if (this.writtenBytes === this.expectedBytes && this.currentMeta) {
					completed.push({
						payload: this.buffer,
						meta: this.currentMeta,
					});
				}
				this.reset();
			}
		}

		return completed;
	}

	private reset() {
		this.buffer = undefined;
		this.remainingRecords = 0;
		this.writtenBytes = 0;
		this.expectedBytes = 0;
		this.currentMeta = undefined;
	}
}

/**
 * Convert a list of chunks into framed AppendRecords for a single message.
 *
 * The first record carries framing headers; subsequent records carry only
 * payload.
 */
export function frameChunksToRecords(chunks: Uint8Array[]): AppendRecord[] {
	if (chunks.length === 0) return [];

	const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const numRecords = chunks.length;

	return chunks.map((chunk, index) => {
		let headers: AppendHeaders<"bytes"> | undefined;
		if (index === 0) {
			headers = makeFrameHeaders(totalBytes, numRecords);
		}
		return AppendRecord.make(chunk, headers);
	});
}
