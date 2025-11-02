import type { S2RequestOptions } from "../../../../common.js";
import {
	FencingTokenMismatchError,
	RangeNotSatisfiableError,
	S2Error,
	SeqNumMismatchError,
} from "../../../../error.js";
import type { Client } from "../../../../generated/client/index.js";
import {
	type AppendAck,
	append,
	checkTail,
	type AppendInput as GeneratedAppendInput,
	type AppendRecord as GeneratedAppendRecord,
	type ReadBatch as GeneratedReadBatch,
	type SequencedRecord as GeneratedSequencedRecord,
	type ReadData,
	read,
	type StreamPosition,
} from "../../../../generated/index.js";
import {
	computeAppendRecordFormat,
	meteredSizeBytes,
} from "../../../../utils.js";
import { decodeFromBase64, encodeToBase64 } from "../../../base64.js";
import type {
	AppendArgs,
	AppendHeaders,
	AppendRecord,
	AppendRecordForFormat,
	ReadArgs,
	ReadBatch,
} from "../../types.js";

export async function streamRead<Format extends "string" | "bytes" = "string">(
	stream: string,
	client: Client,
	args?: ReadArgs<Format>,
	options?: S2RequestOptions,
) {
	const { as, ...queryParams } = args ?? {};
	const response = await read({
		client,
		path: {
			stream,
		},
		headers: {
			...(as === "bytes" ? { "s2-format": "base64" } : {}),
		},
		query: queryParams,
		...options,
	});
	if (response.error) {
		if ("message" in response.error) {
			throw new S2Error({
				message: response.error.message,
				code: response.error.code ?? undefined,
				status: response.response.status,
			});
		} else {
			// special case for 416 - Range Not Satisfiable
			throw new RangeNotSatisfiableError({
				status: response.response.status,
			});
		}
	}

	if (args?.as === "bytes") {
		const res: ReadBatch<"bytes"> = {
			...response.data,
			records: response.data.records?.map(
				(record: GeneratedSequencedRecord) => ({
					...record,
					body: record.body ? decodeFromBase64(record.body) : undefined,
					headers: record.headers?.map(
						(header: [string, string]) =>
							header.map((h: string) => decodeFromBase64(h)) as [
								Uint8Array,
								Uint8Array,
							],
					),
				}),
			),
		};
		return res as ReadBatch<Format>;
	} else {
		const res: ReadBatch<"string"> = {
			...response.data,
			records: response.data.records.map((record) => ({
				...record,
				headers: record.headers
					? Object.fromEntries(record.headers)
					: undefined,
			})),
		};
		return res as ReadBatch<Format>;
	}
}

export async function streamAppend(
	stream: string,
	client: Client,
	records: AppendRecord | AppendRecord[],
	args?: Omit<AppendArgs, "records">,
	options?: S2RequestOptions,
) {
	const recordsArray = Array.isArray(records) ? records : [records];

	if (recordsArray.length === 0) {
		throw new S2Error({ message: "Cannot append empty array of records" });
	}

	let batchMeteredSize = 0;

	for (const record of recordsArray) {
		batchMeteredSize += meteredSizeBytes(record);
	}

	if (batchMeteredSize > 1024 * 1024) {
		throw new S2Error({
			message: `Batch size ${batchMeteredSize} bytes exceeds maximum of 1 MiB (1048576 bytes)`,
		});
	}
	if (recordsArray.length > 1000) {
		throw new S2Error({
			message: `Batch of ${recordsArray.length} exceeds maximum batch size of 1000 records`,
		});
	}

	let encodedRecords: GeneratedAppendRecord[] = [];
	let hasAnyBytesRecords = false;

	for (const record of recordsArray) {
		const format = computeAppendRecordFormat(record);
		if (format === "bytes") {
			const formattedRecord = record as AppendRecordForFormat<"bytes">;
			const encodedRecord = {
				...formattedRecord,
				body: formattedRecord.body
					? encodeToBase64(formattedRecord.body)
					: undefined,
				headers: formattedRecord.headers?.map((header) =>
					header.map((h) => encodeToBase64(h)),
				) as [string, string][] | undefined,
			};

			encodedRecords.push(encodedRecord);
		} else {
			// Normalize headers to array format
			const normalizeHeaders = (
				headers: AppendHeaders<"string">,
			): [string, string][] | undefined => {
				if (headers === undefined) {
					return undefined;
				} else if (Array.isArray(headers)) {
					return headers;
				} else {
					return Object.entries(headers);
				}
			};

			const formattedRecord = record as AppendRecordForFormat<"string">;
			const encodedRecord = {
				...formattedRecord,
				headers: formattedRecord.headers
					? normalizeHeaders(formattedRecord.headers)
					: undefined,
			};

			encodedRecords.push(encodedRecord);
		}
	}

	const response = await append({
		client,
		path: {
			stream,
		},
		body: {
			fencing_token: args?.fencing_token,
			match_seq_num: args?.match_seq_num,
			records: encodedRecords,
		},
		headers: {
			...(hasAnyBytesRecords ? { "s2-format": "base64" } : {}),
		},
		...options,
	});
	if (response.error) {
		if ("message" in response.error) {
			throw new S2Error({
				message: response.error.message,
				code: response.error.code ?? undefined,
				status: response.response.status,
			});
		} else {
			// special case for 412 - append condition failed
			if ("seq_num_mismatch" in response.error) {
				throw new SeqNumMismatchError({
					message: "Append condition failed: sequence number mismatch",
					code: "APPEND_CONDITION_FAILED",
					status: response.response.status,
					expectedSeqNum: response.error.seq_num_mismatch,
				});
			} else if ("fencing_token_mismatch" in response.error) {
				throw new FencingTokenMismatchError({
					message: "Append condition failed: fencing token mismatch",
					code: "APPEND_CONDITION_FAILED",
					status: response.response.status,
					expectedFencingToken: response.error.fencing_token_mismatch,
				});
			} else {
				// fallback for unknown 412 error format
				throw new S2Error({
					message: "Append condition failed",
					status: response.response.status,
				});
			}
		}
	}
	return response.data;
}
