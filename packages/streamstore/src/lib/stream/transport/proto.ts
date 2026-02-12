import { S2Error } from "../../../error.js";
import type * as API from "../../../generated/index.js";
import * as Proto from "../../../generated/proto/s2.js";
import type * as Types from "../../../types.js";
import type { AppendRecord, ReadBatch } from "../types.js";

const textEncoder = new TextEncoder();

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export function bigintToSafeNumber(value: bigint, field: string): number {
	if (value > MAX_SAFE_BIGINT) {
		throw new S2Error({
			message: `${field} exceeds JavaScript Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}); use protobuf transport with bigint support or ensure values stay within 53-bit range`,
			code: "UNSAFE_INTEGER",
			status: 0,
			origin: "sdk",
		});
	}
	return Number(value);
}

const toBytes = (value?: string | Uint8Array | null): Uint8Array => {
	if (value === undefined || value === null) {
		return new Uint8Array();
	}
	return typeof value === "string" ? textEncoder.encode(value) : value;
};

const toProtoHeaders = (
	headers: AppendRecord["headers"],
): Proto.AppendRecord["headers"] => {
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

const toProtoAppendRecord = (record: AppendRecord): Proto.AppendRecord => {
	let timestamp: bigint | undefined;
	if (record.timestamp !== undefined) {
		const ms =
			typeof record.timestamp === "number"
				? record.timestamp
				: record.timestamp.getTime();
		timestamp = BigInt(ms);
	}
	return {
		timestamp,
		headers: toProtoHeaders(record.headers),
		body: toBytes(record.body),
	};
};

const fromProtoPosition = (
	position: Proto.StreamPosition | undefined,
): API.StreamPosition | undefined => {
	if (!position) {
		return undefined;
	}
	return {
		seq_num: bigintToSafeNumber(position.seqNum, "StreamPosition.seqNum"),
		timestamp: Number(position.timestamp),
	};
};

const toSDKStreamPosition = (pos: API.StreamPosition): Types.StreamPosition => {
	return {
		seqNum: pos.seq_num,
		timestamp: new Date(pos.timestamp),
	};
};

const fromProtoSequencedRecord = (
	record: Proto.SequencedRecord,
): ReadBatch<"bytes">["records"][number] => {
	return {
		seq_num: bigintToSafeNumber(record.seqNum, "SequencedRecord.seqNum"),
		timestamp: Number(record.timestamp),
		headers:
			record.headers?.map(
				(header) => [header.name, header.value] as [Uint8Array, Uint8Array],
			) ?? [],
		body: record.body,
	};
};

export const buildProtoAppendInput = (
	input: Types.AppendInput,
): Proto.AppendInput => {
	return Proto.AppendInput.create({
		records: [...input.records].map((record) => toProtoAppendRecord(record)),
		fencingToken:
			input.fencingToken === null
				? undefined
				: (input.fencingToken ?? undefined),
		matchSeqNum:
			input.matchSeqNum !== undefined ? BigInt(input.matchSeqNum) : undefined,
	});
};

const ensureUint8Array = (data: ArrayBuffer | Uint8Array): Uint8Array => {
	return data instanceof Uint8Array ? data : new Uint8Array(data);
};

export const encodeProtoAppendInput = (
	input: Types.AppendInput,
): Uint8Array => {
	return Proto.AppendInput.toBinary(buildProtoAppendInput(input));
};

export const decodeProtoAppendAck = (
	data: ArrayBuffer | Uint8Array,
): Proto.AppendAck => {
	return Proto.AppendAck.fromBinary(ensureUint8Array(data));
};

export const protoAppendAckToJson = (ack: Proto.AppendAck): Types.AppendAck => {
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
		start: toSDKStreamPosition(start),
		end: toSDKStreamPosition(end),
		tail: toSDKStreamPosition(tail),
	};
};

export const decodeProtoReadBatch = (
	data: ArrayBuffer | Uint8Array,
): ReadBatch<"bytes"> => {
	const protoBatch: Proto.ReadBatch = Proto.ReadBatch.fromBinary(
		ensureUint8Array(data),
	);
	return {
		records: protoBatch.records.map((record) =>
			fromProtoSequencedRecord(record),
		),
		tail: fromProtoPosition(protoBatch.tail),
	};
};
