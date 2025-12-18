import type { S2RequestOptions } from "../../../../common.js";
import {
	makeAppendPreconditionError,
	makeServerError,
	RangeNotSatisfiableError,
	S2Error,
	s2Error,
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
import { computeAppendRecordFormat, meteredBytes } from "../../../../utils.js";
import type {
	AppendArgs,
	AppendRecord,
	AppendRecordForFormat,
	ReadArgs,
	ReadBatch,
} from "../../types.js";
import {
	decodeProtoAppendAck,
	decodeProtoReadBatch,
	encodeProtoAppendInput,
	protoAppendAckToJson,
} from "../proto.js";

export async function streamRead<Format extends "string" | "bytes" = "string">(
	stream: string,
	client: Client,
	args?: ReadArgs<Format>,
	options?: S2RequestOptions,
) {
	const { as, ...queryParams } = args ?? {};
	const wantsBytes = (as ?? "string") === "bytes";
	let response: any;
	try {
		response = await read({
			client,
			path: {
				stream,
			},
			headers: wantsBytes ? { Accept: "application/protobuf" } : undefined,
			query: queryParams,
			parseAs: wantsBytes ? "arrayBuffer" : undefined,
			...options,
		});
	} catch (error) {
		throw s2Error(error);
	}
	if (response.error) {
		const status = response.response.status;
		if (status === 416) {
			throw new RangeNotSatisfiableError({ status });
		}
		throw makeServerError(
			{ status, statusText: response.response.statusText },
			response.error,
		);
	}

	if (wantsBytes) {
		const batch = decodeProtoReadBatch(response.data as ArrayBuffer);
		return batch as ReadBatch<Format>;
	}

	const res: ReadBatch<"string"> = {
		...response.data,
		records:
			response.data.records?.map((record: GeneratedSequencedRecord) => ({
				...record,
				headers: record.headers
					? Object.fromEntries(record.headers)
					: undefined,
			})) ?? [],
	};
	return res as ReadBatch<Format>;
}

type FetchAppendOptions = S2RequestOptions & {
	preferProtobuf?: boolean;
};

export async function streamAppend(
	stream: string,
	client: Client,
	records: AppendRecord | AppendRecord[],
	args?: Omit<AppendArgs, "records">,
	options?: FetchAppendOptions,
) {
	const recordsArray = Array.isArray(records) ? records : [records];
	const { preferProtobuf, ...requestOptions } = options ?? {};

	if (recordsArray.length === 0) {
		throw new S2Error({ message: "Cannot append empty array of records" });
	}

	let batchMeteredSize = 0;

	for (const record of recordsArray) {
		batchMeteredSize += meteredBytes(record);
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

	const hasAnyBytesRecords =
		preferProtobuf ??
		recordsArray.some(
			(record) => computeAppendRecordFormat(record) === "bytes",
		);

	let response: any;

	if (hasAnyBytesRecords) {
		const protoBody = encodeProtoAppendInput(recordsArray, args);

		const headers = {
			Accept: "application/protobuf",
			"Content-Type": "application/protobuf",
		};

		try {
			response = await append({
				client,
				path: {
					stream,
				},
				body: protoBody as unknown as GeneratedAppendInput,
				bodySerializer: null,
				parseAs: "arrayBuffer",
				headers,
				...requestOptions,
			});
		} catch (error) {
			throw s2Error(error);
		}
		if (response.error) {
			const status = response.response.status;
			if (status === 412) {
				throw makeAppendPreconditionError(status, response.error);
			}
			throw makeServerError(
				{ status, statusText: response.response.statusText },
				response.error,
			);
		}

		const ack = decodeProtoAppendAck(response.data as ArrayBuffer);
		return protoAppendAckToJson(ack);
	}

	const encodedRecords: GeneratedAppendRecord[] = recordsArray.map((record) => {
		const formattedRecord = record as AppendRecordForFormat<"string">;
		return {
			...formattedRecord,
		};
	});

	try {
		response = await append({
			client,
			path: {
				stream,
			},
			body: {
				fencing_token: args?.fencingToken,
				match_seq_num: args?.matchSeqNum,
				records: encodedRecords,
			},
			...requestOptions,
		});
	} catch (error) {
		throw s2Error(error);
	}
	if (response.error) {
		const status = response.response.status;
		if (status === 412) {
			throw makeAppendPreconditionError(status, response.error);
		}
		throw makeServerError(
			{ status, statusText: response.response.statusText },
			response.error,
		);
	}
	return response.data;
}
