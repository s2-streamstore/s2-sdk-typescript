import type {
	AppendHeaders,
	AppendRecord as AppendRecordType,
} from "./stream.js";

export type AppendRecord = AppendRecordType;

/**
 * Helpers to construct appendable records.
 *
 * These helpers mirror the OpenAPI record schema and add convenience builders for S2 command records:
 * - `make` creates a normal record
 * - `command` creates a command record with an empty-name header set to the command name
 * - `fence` is a command record enforcing a fencing token
 * - `trim` is a command record that encodes a sequence number for trimming
 */
export const AppendRecord = {
	// overloads for only string or only bytes
	make: <Format extends "string" | "bytes">(
		body?: Format extends "string" ? string : Uint8Array,
		headers?: AppendHeaders<Format>,
		timestamp?: number,
	): AppendRecord => {
		return {
			body,
			headers,
			timestamp,
		} as AppendRecord;
	},
	command: <Format extends "string" | "bytes">(
		/** Command name (e.g. "fence" or "trim"). */
		command: string,
		body?: Format extends "string" ? string : Uint8Array,
		additionalHeaders?: AppendHeaders<Format>,
		timestamp?: number,
	): AppendRecord => {
		const format = typeof body === "string" ? "string" : "bytes";
		// todo: handle additional headers
		const headers = (
			format === "string"
				? [["", command]]
				: [[new TextEncoder().encode(""), new TextEncoder().encode(command)]]
		) as AppendHeaders<Format>;
		return AppendRecord.make(body, headers, timestamp);
	},
	fence: (
		fencing_token: string,
		additionalHeaders?: AppendHeaders<"string">,
		timestamp?: number,
	): AppendRecord => {
		return AppendRecord.command(
			"fence",
			fencing_token,
			additionalHeaders,
			timestamp,
		);
	},
	trim: (
		seqNum: number | bigint,
		headers?: AppendHeaders<"bytes">,
		timestamp?: number,
	): AppendRecord => {
		// Encode sequence number as 8 big-endian bytes
		const buffer = new Uint8Array(8);
		const view = new DataView(buffer.buffer);
		view.setBigUint64(0, BigInt(seqNum), false); // false = big-endian
		return AppendRecord.command("trim", buffer, headers, timestamp);
	},
} as const;

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
 * Calculate the metered size in bytes of an AppendRecord.
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
export function meteredSizeBytes(record: AppendRecord): number {
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
