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
	fromAPIStreamPosition,
	toAPIAppendRecord,
} from "../../../../internal/mappers.js";
import type * as Types from "../../../../types.js";
import { computeAppendRecordFormat } from "../../../../utils.js";
import { streamConfigHeaders } from "../../../stream-config.js";
import type {
	AppendRecordForFormat,
	ReadArgs,
	ReadBatch,
} from "../../types.js";

const loadProtoCodec = async () => {
	try {
		return await import("../proto.js");
	} catch (cause) {
		// Not s2Error: a browser may word a failed import like a failed fetch,
		// which s2Error would treat as a retryable network error.
		const error = new S2Error({
			message: `Failed to load the protobuf codec: ${cause instanceof Error ? cause.message : String(cause)}`,
		});
		error.cause = cause;
		throw error;
	}
};

function decodeProto<T>(label: string, decode: () => T): T {
	try {
		return decode();
	} catch (cause) {
		if (cause instanceof S2Error) {
			throw cause;
		}
		// A complete HTTP 200 body that cannot be decoded is a non-retryable
		// protocol error; don't pass through s2Error() message matching.
		const error = new S2Error({
			message: `Failed to decode ${label} protobuf response: ${cause instanceof Error ? cause.message : String(cause)}`,
			code: "INVALID_RESPONSE",
			origin: "sdk",
		});
		error.cause = cause;
		throw error;
	}
}

type RequestOptionsWithHeaders = S2RequestOptions & {
	headers?: Record<string, string>;
};

function mergeHeaders(
	...headersList: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
	const merged = Object.assign(
		{},
		...headersList.filter((headers): headers is Record<string, string> =>
			Boolean(headers),
		),
	);

	return Object.keys(merged).length > 0 ? merged : undefined;
}

/** The error for a failed read response. A 416 carries the stream's tail. */
export function readResponseError(
	response: { status: number; statusText?: string },
	payload: unknown,
): S2Error {
	if (response.status === 416) {
		const err =
			typeof payload === "object" && payload !== null
				? (payload as { code?: string; tail?: API.StreamPosition })
				: undefined;
		return new RangeNotSatisfiableError({
			status: response.status,
			code: err?.code,
			tail: err?.tail ? fromAPIStreamPosition(err.tail) : undefined,
		});
	}
	return makeServerError(response, payload);
}

export async function streamRead<Format extends "string" | "bytes" = "string">(
	stream: string,
	client: Client,
	args?: ReadArgs<Format>,
	options?: RequestOptionsWithHeaders,
) {
	const { as, ignore_command_records, stream_config, ...queryParams } =
		args ?? {};
	const { headers: customHeaders, ...requestOptions } = options ?? {};
	const wantsBytes = (as ?? "string") === "bytes";
	let response: any;
	try {
		response = await read({
			client,
			path: {
				stream,
			},
			headers: mergeHeaders(
				customHeaders,
				streamConfigHeaders(stream_config),
				wantsBytes ? { Accept: "application/protobuf" } : undefined,
			),
			query: queryParams,
			parseAs: wantsBytes ? "arrayBuffer" : undefined,
			...requestOptions,
		});
	} catch (error) {
		throw s2Error(error);
	}
	if (response.error || !response.response.ok) {
		throw readResponseError(response.response, response.error);
	}

	if (wantsBytes) {
		const { decodeProtoReadBatch } = await loadProtoCodec();
		const batch = decodeProto("ReadBatch", () =>
			decodeProtoReadBatch(response.data as ArrayBuffer),
		);
		return batch as ReadBatch<Format>;
	}

	const res: ReadBatch<"string"> = {
		...response.data,
		records:
			response.data.records?.map((record: API.SequencedRecord) => ({
				...record,
				headers: record.headers || undefined,
			})) ?? [],
	};
	return res as ReadBatch<Format>;
}

type FetchAppendOptions = RequestOptionsWithHeaders & {
	preferProtobuf?: boolean;
};

export async function streamAppend(
	stream: string,
	client: Client,
	input: Types.AppendInput,
	options?: FetchAppendOptions,
) {
	const {
		preferProtobuf,
		headers: customHeaders,
		...requestOptions
	} = options ?? {};

	const hasAnyBytesRecords = input.records.some(
		(record) => computeAppendRecordFormat(record) === "bytes",
	);
	const useProtobuf = hasAnyBytesRecords || preferProtobuf === true;

	let response: any;

	if (useProtobuf) {
		const {
			decodeProtoAppendAck,
			encodeProtoAppendInput,
			protoAppendAckToJson,
		} = await loadProtoCodec();
		const protoBody = encodeProtoAppendInput(input);

		const headers = mergeHeaders(customHeaders, {
			Accept: "application/protobuf",
			"Content-Type": "application/protobuf",
		});

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
		if (response.error || !response.response.ok) {
			const status = response.response.status;
			if (status === 412) {
				throw makeAppendPreconditionError(status, response.error);
			}
			throw makeServerError(
				{ status, statusText: response.response.statusText },
				response.error,
			);
		}

		return decodeProto("AppendAck", () => {
			const ack = decodeProtoAppendAck(response.data as ArrayBuffer);
			return protoAppendAckToJson(ack);
		});
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
			headers: customHeaders,
			...requestOptions,
		});
	} catch (error) {
		throw s2Error(error);
	}
	if (response.error || !response.response.ok) {
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
