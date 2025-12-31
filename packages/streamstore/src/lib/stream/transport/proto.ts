import { S2Error } from "../../../error.js";
import type * as API from "../../../generated/index.js";
import * as Proto from "../../../generated/proto/s2.js";
import type * as Types from "../../../types.js";
import type { AppendRecord, ReadBatch } from "../types.js";

const textEncoder = new TextEncoder();

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
	return {
		timestamp:
			record.timestamp !== undefined ? BigInt(record.timestamp) : undefined,
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
		seq_num: Number(position.seqNum),
		timestamp: Number(position.timestamp),
	};
};

const fromProtoSequencedRecord = (
	record: Proto.SequencedRecord,
): ReadBatch<"bytes">["records"][number] => {
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
	args?: Omit<Types.AppendInput, "records" | "meteredBytes">,
): Proto.AppendInput => {
	return Proto.AppendInput.create({
		records: records.map((record) => toProtoAppendRecord(record)),
		fencingToken:
			args?.fencing_token === null
				? undefined
				: (args?.fencing_token ?? undefined),
		matchSeqNum:
			args?.match_seq_num !== undefined
				? BigInt(args.match_seq_num)
				: undefined,
	});
};

const ensureUint8Array = (data: ArrayBuffer | Uint8Array): Uint8Array => {
	return data instanceof Uint8Array ? data : new Uint8Array(data);
};

export const encodeProtoAppendInput = (
	records: AppendRecord[],
	args?: Omit<Types.AppendInput, "records" | "meteredBytes">,
): Uint8Array => {
	return Proto.AppendInput.toBinary(buildProtoAppendInput(records, args));
};

export const decodeProtoAppendAck = (
	data: ArrayBuffer | Uint8Array,
): Proto.AppendAck => {
	return Proto.AppendAck.fromBinary(ensureUint8Array(data));
};

export const protoAppendAckToJson = (ack: Proto.AppendAck): API.AppendAck => {
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
