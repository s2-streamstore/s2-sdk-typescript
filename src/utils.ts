import type { AppendRecord as AppendRecordType } from "./stream";

type Headers =
	| Record<string, string>
	| Array<[string | Uint8Array, string | Uint8Array]>;

export const AppendRecord = {
	make: (
		body?: string | Uint8Array,
		headers?: Headers,
		timestamp?: AppendRecordType["timestamp"],
	): AppendRecordType => {
		return {
			body,
			headers,
			timestamp,
		};
	},
	command: (
		command: string,
		body?: string | Uint8Array,
		additionalHeaders?: Headers,
		timestamp?: AppendRecordType["timestamp"],
	): AppendRecordType => {
		const headers: AppendRecordType["headers"] = (() => {
			if (!additionalHeaders) {
				return [["", command]];
			} else if (Array.isArray(additionalHeaders)) {
				return [["", command] as [string, string], ...additionalHeaders];
			} else {
				return [
					["", command] as [string, string],
					...Object.entries(additionalHeaders).map(
						([key, value]) => [key, value] as [string, string],
					),
				];
			}
		})();
		return {
			body,
			headers,
			timestamp,
		};
	},
	fence: (
		fencing_token: string,
		additionalHeaders?: Headers,
		timestamp?: AppendRecordType["timestamp"],
	) => {
		return AppendRecord.command(
			"fence",
			fencing_token,
			additionalHeaders,
			timestamp,
		);
	},
	trim: (
		seqNum: number | bigint,
		additionalHeaders?: Headers,
		timestamp?: AppendRecordType["timestamp"],
	): AppendRecordType => {
		// Encode sequence number as 8 big-endian bytes
		const buffer = new Uint8Array(8);
		const view = new DataView(buffer.buffer);
		view.setBigUint64(0, BigInt(seqNum), false); // false = big-endian
		return AppendRecord.command("trim", buffer, additionalHeaders, timestamp);
	},
} as const;
