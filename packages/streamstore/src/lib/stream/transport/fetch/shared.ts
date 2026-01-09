import type { S2RequestOptions } from "../../../../common.js";
import {
	makeAppendPreconditionError,
	makeServerError,
	RangeNotSatisfiableError,
	S2Error,
	s2Error,
} from "../../../../error.js";
import type { Client } from "../../../../generated/client/index.js";
import type * as API from "../../../../generated/index.js";
import { append, read } from "../../../../generated/index.js";
import {
	fromAPIAppendAck,
	toAPIAppendRecord,
} from "../../../../internal/mappers.js";
import type * as Types from "../../../../types.js";
import { computeAppendRecordFormat } from "../../../../utils.js";
import type {
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
			const err = response.error as {
				tail?: { seq_num: number; timestamp: number };
				code?: string;
			};
			throw new RangeNotSatisfiableError({
				status,
				tail: err.tail,
				code: err.code,
			});
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
			response.data.records?.map((record: API.SequencedRecord) => ({
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
	input: Types.AppendInput,
	options?: FetchAppendOptions,
) {
	const { preferProtobuf, ...requestOptions } = options ?? {};

	const hasAnyBytesRecords = input.records.some(
		(record) => computeAppendRecordFormat(record) === "bytes",
	);
	const useProtobuf = hasAnyBytesRecords || preferProtobuf === true;

	let response: any;

	if (useProtobuf) {
		const protoBody = encodeProtoAppendInput(input);

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
				body: protoBody as unknown as API.AppendInput,
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

	const encodedRecords: API.AppendRecord[] = [...input.records].map(
		toAPIAppendRecord,
	);

	try {
		response = await append({
			client,
			path: {
				stream,
			},
			body: {
				fencing_token: input.fencingToken,
				match_seq_num: input.matchSeqNum,
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
	return fromAPIAppendAck(response.data);
}
