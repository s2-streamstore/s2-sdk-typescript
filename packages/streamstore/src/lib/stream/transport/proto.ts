import { S2Error } from "../../../error.js";
import type { AppendAck, StreamPosition } from "../../../generated/index.js";
import {
	AppendAck as ProtoAppendAck,
	AppendInput as ProtoAppendInput,
	type AppendRecord as ProtoAppendRecord,
	type ReadBatch as ProtoReadBatch,
	ReadBatch as ProtoReadBatchMessage,
	type SequencedRecord as ProtoSequencedRecord,
	type StreamPosition as ProtoStreamPosition,
} from "../../../generated/proto/s2.js";
import type {
	AppendArgs,
	AppendRecord,
	ReadBatch as ReadBatchResult,
} from "../types.js";

const textEncoder = new TextEncoder();

const toBytes = (value?: string | Uint8Array | null): Uint8Array => {
	if (value === undefined || value === null) {
		return new Uint8Array();
	}
	return typeof value === "string" ? textEncoder.encode(value) : value;
};

const toProtoHeaders = (
	headers: AppendRecord["headers"],
): ProtoAppendRecord["headers"] => {
	if (!headers) {
		return [];
	}
	return (headers as Array<[string | Uint8Array, string | Uint8Array]>).map(
		([name, value]) => ({
			name: toBytes(name),
			value: toBytes(value),
		}),
	);
};

const toProtoAppendRecord = (record: AppendRecord): ProtoAppendRecord => {
	const timestampValue =
		record.timestamp === undefined || record.timestamp === null
			? undefined
			: BigInt(record.timestamp);
	return {
		timestamp: timestampValue,
		headers: toProtoHeaders(record.headers),
		body: toBytes(record.body),
	};
};

const fromProtoPosition = (
	position: ProtoStreamPosition | undefined,
): StreamPosition | undefined => {
	if (!position) {
		return undefined;
	}
	return {
		seq_num: Number(position.seqNum),
		timestamp: Number(position.timestamp),
	};
};

const fromProtoSequencedRecord = (
	record: ProtoSequencedRecord,
): ReadBatchResult<"bytes">["records"][number] => {
	return {
		seq_num: Number(record.seqNum),
		timestamp: Number(record.timestamp),
		headers:
			record.headers?.map(
				(header) => [header.name, header.value] as [Uint8Array, Uint8Array],
			) ?? [],
		body: record.body,
	};
};

export const buildProtoAppendInput = (
	records: AppendRecord[],
	args?: Omit<AppendArgs, "records">,
): ProtoAppendInput => {
	return ProtoAppendInput.create({
		records: records.map((record) => toProtoAppendRecord(record)),
		fencingToken:
			args?.fencingToken === null
				? undefined
				: (args?.fencingToken ?? undefined),
		matchSeqNum:
			args?.matchSeqNum === undefined ? undefined : BigInt(args.matchSeqNum),
	});
};

const ensureUint8Array = (data: ArrayBuffer | Uint8Array): Uint8Array => {
	return data instanceof Uint8Array ? data : new Uint8Array(data);
};

export const encodeProtoAppendInput = (
	records: AppendRecord[],
	args?: Omit<AppendArgs, "records">,
): Uint8Array => {
	return ProtoAppendInput.toBinary(buildProtoAppendInput(records, args));
};

export const decodeProtoAppendAck = (
	data: ArrayBuffer | Uint8Array,
): ProtoAppendAck => {
	return ProtoAppendAck.fromBinary(ensureUint8Array(data));
};

export const protoAppendAckToJson = (ack: ProtoAppendAck): AppendAck => {
	const start = fromProtoPosition(ack.start);
	const end = fromProtoPosition(ack.end);

	if (!start || !end) {
		throw new S2Error({
			message: "AppendAck missing start or end positions",
			status: 500,
			origin: "sdk",
		});
	}

	const tail = fromProtoPosition(ack.tail) ?? end;
	return {
		start,
		end,
		tail,
	};
};

export const decodeProtoReadBatch = (
	data: ArrayBuffer | Uint8Array,
): ReadBatchResult<"bytes"> => {
	const protoBatch: ProtoReadBatch = ProtoReadBatchMessage.fromBinary(
		ensureUint8Array(data),
	);
	return {
		records: protoBatch.records.map((record) =>
			fromProtoSequencedRecord(record),
		),
		tail: fromProtoPosition(protoBatch.tail),
	};
};
