import type { AppendRecord, ReadRecord } from "./lib/stream/types.js";

/**
 * Calculate the UTF-8 byte length of a string.
 * Handles all Unicode characters including surrogate pairs correctly.
 *
 * @param str The string to measure
 * @returns The byte length when encoded as UTF-8
 */
export function utf8ByteLength(str: string): number {
	let bytes = 0;
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);

		if (code <= 0x7f) {
			bytes += 1;
		} else if (code <= 0x7ff) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			// high surrogate
			if (i + 1 < str.length) {
				const next = str.charCodeAt(i + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					// valid surrogate pair → 4 bytes in UTF-8
					bytes += 4;
					i++; // skip low surrogate
				} else {
					// unpaired high surrogate → treat as 3 bytes (replacement-style)
					bytes += 3;
				}
			} else {
				// unpaired high surrogate at end of string
				bytes += 3;
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			// lone low surrogate — treat as 3 bytes
			bytes += 3;
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

/**
 * Calculate the metered size in bytes of a record (append or read).
 * This includes the body and headers, but not metadata like timestamp.
 *
 * This function calculates how many bytes the record will occupy
 * after being received and deserialized as raw bytes on the S2 side.
 * For strings, it calculates UTF-8 byte length. For Uint8Array, it uses
 * the array length directly (same value as would be used when encoding
 * to base64 for transmission).
 *
 * @param record The record to measure
 * @returns The size in bytes
 */
export function meteredBytes<Format extends "string" | "bytes">(
	record: AppendRecord | ReadRecord<Format>,
): number {
	// Calculate header size based on actual data types
	let numHeaders = 0;
	let headersSize = 0;

	if (record.headers) {
		if (Array.isArray(record.headers)) {
			numHeaders = record.headers.length;
			headersSize = record.headers.reduce((sum, [k, v]) => {
				// Infer format from key type: string = UTF-8 bytes, Uint8Array = byte length
				const keySize = typeof k === "string" ? utf8ByteLength(k) : k.length;
				const valueSize = typeof v === "string" ? utf8ByteLength(v) : v.length;
				return sum + keySize + valueSize;
			}, 0);
		} else {
			// Record<string, string> format (only for string format)
			const entries = Object.entries(record.headers);
			numHeaders = entries.length;
			headersSize = entries.reduce((sum, [k, v]) => {
				return sum + utf8ByteLength(k) + utf8ByteLength(v);
			}, 0);
		}
	}

	// Calculate body size based on actual data type
	const bodySize = record.body
		? typeof record.body === "string"
			? utf8ByteLength(record.body)
			: record.body.length
		: 0;

	return 8 + 2 * numHeaders + headersSize + bodySize;
}

export function computeAppendRecordFormat(
	record: AppendRecord,
): "string" | "bytes" {
	let result: "string" | "bytes" = "string";

	if (record.body && typeof record.body !== "string") {
		result = "bytes";
	}
	if (
		record.headers &&
		Array.isArray(record.headers) &&
		record.headers.some(
			([k, v]) => typeof k !== "string" || typeof v !== "string",
		)
	) {
		result = "bytes";
	}

	return result;
}
