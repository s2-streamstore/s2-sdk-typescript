import type {
	AppendRecord as AppendRecordType,
	BytesAppendRecord,
	StringAppendRecord,
} from "./stream.js";

type StringHeaders = Record<string, string> | Array<[string, string]>;
type BytesHeaders = Array<[Uint8Array, Uint8Array]>;

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
	make: {
		string: (
			body?: string,
			headers?: StringHeaders,
			timestamp?: number,
		): StringAppendRecord => {
			return {
				format: "string",
				body,
				headers,
				timestamp,
			};
		},
		bytes: (
			body?: Uint8Array,
			headers?: BytesHeaders,
			timestamp?: number,
		): BytesAppendRecord => {
			return {
				format: "bytes",
				body,
				headers,
				timestamp,
			};
		},
	},
	command: {
		string: (
			/** Command name (e.g. "fence" or "trim"). */
			command: string,
			body?: string,
			timestamp?: number,
		): StringAppendRecord => {
			const headers: Array<[string, string]> = [["", command]];
			return {
				format: "string",
				body,
				headers,
				timestamp,
			};
		},
		bytes: (
			/** Command name (e.g. "fence" or "trim"). */
			command: string,
			body?: Uint8Array,
			timestamp?: number,
		): BytesAppendRecord => {
			const headers: BytesHeaders = [
				[new Uint8Array(), new TextEncoder().encode(command)],
			];
			return {
				format: "bytes",
				body,
				headers,
				timestamp,
			};
		},
	},
	fence: {
		string: (fencing_token: string, timestamp?: number): StringAppendRecord => {
			return AppendRecord.command.string("fence", fencing_token, timestamp);
		},
		bytes: (fencing_token: string, timestamp?: number): BytesAppendRecord => {
			return AppendRecord.command.bytes(
				"fence",
				new TextEncoder().encode(fencing_token),
				timestamp,
			);
		},
	},
	trim: (seqNum: number | bigint, timestamp?: number): BytesAppendRecord => {
		// Encode sequence number as 8 big-endian bytes
		const buffer = new Uint8Array(8);
		const view = new DataView(buffer.buffer);
		view.setBigUint64(0, BigInt(seqNum), false); // false = big-endian
		return AppendRecord.command.bytes("trim", buffer, timestamp);
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
 * @param record The record to measure
 * @returns The size in bytes
 */
export function meteredSizeBytes(record: AppendRecordType): number {
	if (record.format === "string") {
		const numHeaders = record.headers
			? Array.isArray(record.headers)
				? record.headers.length
				: Object.keys(record.headers).length
			: 0;
		const headers = (() => {
			if (record.headers) {
				if (Array.isArray(record.headers)) {
					return record.headers
						.map(([k, v]) => utf8ByteLength(k) + utf8ByteLength(v))
						.reduce((a, b) => a + b, 0);
				} else {
					return Object.entries(record.headers)
						.map(([k, v]) => utf8ByteLength(k) + utf8ByteLength(v))
						.reduce((a, b) => a + b, 0);
				}
			} else {
				return 0;
			}
		})();
		const body = record.body ? utf8ByteLength(record.body) : 0;

		return 8 + 2 * numHeaders + headers + body;
	} else {
		const numHeaders = record.headers?.length ?? 0;
		const headers =
			record.headers
				?.map(([k, v]) => k.length + v.length)
				.reduce((a, b) => a + b, 0) ?? 0;
		const body = record.body?.length ?? 0;

		return 8 + 2 * numHeaders + headers + body;
	}
}
