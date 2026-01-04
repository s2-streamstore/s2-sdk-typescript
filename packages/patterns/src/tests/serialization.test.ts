import {
	AppendAck,
	AppendInput,
	AppendRecord,
	meteredBytes,
} from "@s2-dev/streamstore";
import { describe, expect, it } from "vitest";
import { MAX_RECORD_BYTES } from "../patterns/chunking.js";
import {
	FRAME_BYTES_HEADER_BYTES,
	FRAME_RECORDS_HEADER_BYTES,
} from "../patterns/constants.js";
import {
	DedupeFilter,
	extractDedupeSeq,
	injectDedupeHeaders,
} from "../patterns/dedupe.js";
import { FrameAssembler } from "../patterns/framing.js";
import {
	DeserializingReadSession,
	SerializingAppendSession,
} from "../patterns/serialization.js";
import { decodeU64 } from "../patterns/u64.js";

class FakeAppendSession {
	submitted: { record: AppendRecord; matchSeqNum?: number }[] = [];
	private nextSeqNum = 0;

	async submit(input: AppendInput): Promise<any> {
		const batch = Array.isArray(input.records)
			? input.records
			: [input.records];

		for (const r of batch) {
			this.submitted.push({
				record: r,
				matchSeqNum: input.matchSeqNum,
			});
		}

		const count = batch.length;
		const startSeq = this.nextSeqNum;
		const endSeq = startSeq + count;
		const timestamp = 0 as any;

		this.nextSeqNum = endSeq;

		// Minimal AppendAck shape used by SerializingAppendSession.submit
		const ack = {
			start: { seq_num: startSeq, timestamp },
			end: { seq_num: endSeq, timestamp },
			tail: { seq_num: endSeq, timestamp },
		} as AppendAck;

		const bytes = batch.reduce(
			(total, record) => total + meteredBytes(record),
			0,
		);

		return {
			ack: async () => ack,
			bytes,
			numRecords: batch.length,
		};
	}
}

function headerValueBytes(
	headers: [Uint8Array, Uint8Array][],
	keyBytes: Uint8Array,
): Uint8Array | undefined {
	for (const [k, v] of headers) {
		if (k.length !== keyBytes.length) continue;
		let match = true;
		for (let i = 0; i < k.length; i += 1) {
			if (k[i] !== keyBytes[i]) {
				match = false;
				break;
			}
		}
		if (match) return v;
	}
	return undefined;
}

function toByteHeaders(
	headers: AppendRecord["headers"],
): [Uint8Array, Uint8Array][] {
	const enc = new TextEncoder();
	if (!headers) return [];
	return (headers as Array<[string | Uint8Array, string | Uint8Array]>).map(
		([k, v]) => {
			const kb = typeof k === "string" ? enc.encode(k) : (k as Uint8Array);
			const vb = typeof v === "string" ? enc.encode(v) : (v as Uint8Array);
			return [kb, vb];
		},
	);
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type Message = {
	id: number;
	text: string;
	tags?: string[];
};

async function runTests(): Promise<void> {
	const msg1: Message = {
		id: 1,
		text: "hello world",
		tags: ["a", "b"],
	};
	const msg2: Message = {
		id: 2,
		text: "another message",
		tags: ["x"],
	};
	const messages: Message[] = [msg1, msg2];

	const msg1Bytes = textEncoder.encode(JSON.stringify(msg1));
	const msg2Bytes = textEncoder.encode(JSON.stringify(msg2));

	const fakeSession = new FakeAppendSession();
	const chunkSize = 4;

	const session = new SerializingAppendSession<Message>(
		fakeSession as any,
		(m) => textEncoder.encode(JSON.stringify(m)),
		{ chunkSize, matchSeqNum: 10, dedupeSeq: 0 },
	);

	for (const m of messages) {
		await session.submit(m);
	}

	const submitted = fakeSession.submitted;

	const expectedChunksMsg1 = Math.ceil(msg1Bytes.byteLength / chunkSize);
	const expectedChunksMsg2 = Math.ceil(msg2Bytes.byteLength / chunkSize);
	const totalChunks = expectedChunksMsg1 + expectedChunksMsg2;

	// Total records should match expected chunk counts for both messages.
	expect(submitted.length).toBe(totalChunks);

	// matchSeqNum should start at 10 and increment per record.
	const matchSeqNums = submitted.map((s) => s.matchSeqNum);
	expect(matchSeqNums).toEqual(
		Array.from({ length: totalChunks }, (_v, i) => 10 + i),
	);

	// Every record should have a dedupe header (writer id + sequence)
	// where the writer id is constant for the session and the sequence
	// increments from 0.
	const dedupeMeta = submitted.map((s) =>
		extractDedupeSeq(s.record.headers as any),
	);
	expect(dedupeMeta.length).toBe(totalChunks);
	let writerId: string | undefined;
	for (let i = 0; i < dedupeMeta.length; i += 1) {
		const value = dedupeMeta[i];
		expect(value).toBeDefined();
		const [w, seq] = value!;
		if (writerId === undefined) {
			writerId = w;
		} else {
			expect(w).toBe(writerId);
		}
		expect(seq).toBe(i);
	}

	// First record of each message should carry frame headers describing
	// the total bytes and number of records in that frame.
	const records = submitted.map((s) => s.record);

	const msg1Records = records.slice(0, expectedChunksMsg1);
	const msg2Records = records.slice(expectedChunksMsg1);

	const headers0 = toByteHeaders(msg1Records[0]!.headers);
	const frameBytes0 = headerValueBytes(headers0, FRAME_BYTES_HEADER_BYTES)!;
	const frameRecords0 = headerValueBytes(headers0, FRAME_RECORDS_HEADER_BYTES)!;

	expect(Number(decodeU64(frameBytes0))).toBe(msg1Bytes.byteLength);
	expect(Number(decodeU64(frameRecords0))).toBe(expectedChunksMsg1);

	const headers3 = toByteHeaders(msg2Records[0]!.headers);
	const frameBytes3 = headerValueBytes(headers3, FRAME_BYTES_HEADER_BYTES)!;
	const frameRecords3 = headerValueBytes(headers3, FRAME_RECORDS_HEADER_BYTES)!;

	expect(Number(decodeU64(frameBytes3))).toBe(msg2Bytes.byteLength);
	expect(Number(decodeU64(frameRecords3))).toBe(expectedChunksMsg2);

	// All records should respect the S2 per-record size limit.
	for (const r of records) {
		const size = meteredBytes(r);
		expect(size).toBeLessThanOrEqual(MAX_RECORD_BYTES);
	}

	// Read-side 1: use DeserializingReadSession end-to-end.
	const readStream = new ReadableStream<any>({
		start(controller) {
			for (const rec of records) {
				controller.enqueue({
					headers: rec.headers ?? [],
					body: rec.body ?? undefined,
				});
			}
			controller.close();
		},
	});

	const deserializing = new DeserializingReadSession<Message>(
		readStream as any,
		(bytes) => JSON.parse(textDecoder.decode(bytes)) as Message,
	);

	const decodedViaSession: Message[] = [];
	const reader = deserializing.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		decodedViaSession.push(value as Message);
	}

	expect(decodedViaSession.length).toBe(messages.length);
	expect(decodedViaSession[0]).toEqual(msg1);
	expect(decodedViaSession[1]).toEqual(msg2);

	// Read-side 2: use low-level helpers with duplicates and an incomplete frame.
	const withDuplicatesAndTruncation = [
		...records,
		...records, // full duplicate stream
	];
	withDuplicatesAndTruncation.pop(); // drop last record -> incomplete frame

	const assembler2 = new FrameAssembler();
	const dedupe2 = new DedupeFilter();
	const decoded2: Message[] = [];

	for (const rec of withDuplicatesAndTruncation) {
		if (!dedupe2.shouldAccept(rec.headers as any)) {
			continue;
		}
		const frames = assembler2.push({
			headers: (rec.headers ?? []) as any,
			body: rec.body ?? undefined,
		});
		for (const frame of frames) {
			const parsed = JSON.parse(textDecoder.decode(frame.payload)) as Message;
			decoded2.push(parsed);
		}
	}

	expect(decoded2.length).toBe(messages.length);
	expect(decoded2[0]).toEqual(msg1);
	expect(decoded2[1]).toEqual(msg2);
}

describe("serialization patterns", () => {
	it("writes frames with dedupe and matchSeqNum and reconstructs on read", async () => {
		await runTests();
	});

	it("dedupes per writer id and sequence", () => {
		const mkRecord = (): AppendRecord => ({ body: new Uint8Array() });

		const writer1Batch1: AppendRecord[] = [mkRecord(), mkRecord()];
		injectDedupeHeaders(writer1Batch1, "writer-1", 0);

		// Duplicate of the first batch from the same writer.
		const writer1Batch1Dup = writer1Batch1;

		// New writer starting from seq 0 should be treated as a new stream.
		const writer2Batch: AppendRecord[] = [mkRecord(), mkRecord()];
		injectDedupeHeaders(writer2Batch, "writer-2", 0);

		const allRecords = [...writer1Batch1, ...writer1Batch1Dup, ...writer2Batch];

		const dedupe = new DedupeFilter();
		const accepted: AppendRecord[] = [];
		for (const rec of allRecords) {
			if (dedupe.shouldAccept(rec.headers as any)) {
				accepted.push(rec);
			}
		}

		// First writer batch (2 records) + new writer batch (2 records) should be kept.
		// Exact duplicate batch from the same writer should be dropped.
		expect(accepted.length).toBe(4);

		const acceptedMeta = accepted.map((rec) =>
			extractDedupeSeq(rec.headers as any),
		);
		expect(acceptedMeta).toEqual([
			["writer-1", 0],
			["writer-1", 1],
			["writer-2", 0],
			["writer-2", 1],
		]);
	});
});
