/**
 * Regression tests for issue #114:
 * 1. Duplicate headers must be preserved (not collapsed by Object.fromEntries)
 * 2. uint64 values exceeding Number.MAX_SAFE_INTEGER must throw (not silently lose precision)
 */
import { describe, expect, it } from "vitest";
import {
	bigintToSafeNumber,
	decodeProtoReadBatch,
	protoAppendAckToJson,
} from "../lib/stream/transport/proto.js";
import { convertProtoRecord } from "../lib/stream/transport/s2s/index.js";
import * as Proto from "../generated/proto/s2.js";

const textEncoder = new TextEncoder();

// --- Helpers -----------------------------------------------------------------

/** Create a proto Header from string name/value. */
function makeHeader(name: string, value: string): Proto.Header {
	return Proto.Header.create({
		name: textEncoder.encode(name),
		value: textEncoder.encode(value),
	});
}

/** Encode a ReadBatch proto to binary and decode it via the SDK decodeProtoReadBatch. */
function roundTripReadBatch(batch: Proto.ReadBatch) {
	const binary = Proto.ReadBatch.toBinary(batch);
	return decodeProtoReadBatch(binary);
}

// --- bigintToSafeNumber ------------------------------------------------------

describe("bigintToSafeNumber", () => {
	it("converts zero correctly", () => {
		expect(bigintToSafeNumber(0n, "test")).toBe(0);
	});

	it("converts small positive values correctly", () => {
		expect(bigintToSafeNumber(42n, "test")).toBe(42);
	});

	it("converts Number.MAX_SAFE_INTEGER exactly", () => {
		const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
		expect(bigintToSafeNumber(maxSafe, "test")).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("throws for values exceeding Number.MAX_SAFE_INTEGER", () => {
		const unsafeValue = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
		expect(() => bigintToSafeNumber(unsafeValue, "myField")).toThrow(
			/myField exceeds JavaScript Number.MAX_SAFE_INTEGER/,
		);
	});

	it("throws for very large uint64 values", () => {
		// Typical large uint64: 2^63
		const largeValue = 2n ** 63n;
		expect(() => bigintToSafeNumber(largeValue, "seqNum")).toThrow(
			/exceeds JavaScript Number.MAX_SAFE_INTEGER/,
		);
	});

	it("includes the field name in the error message", () => {
		const unsafeValue = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
		expect(() =>
			bigintToSafeNumber(unsafeValue, "StreamPosition.seqNum"),
		).toThrow(/StreamPosition\.seqNum/);
	});
});

// --- Duplicate headers preservation ------------------------------------------

describe("duplicate headers preservation (issue #114)", () => {
	it("preserves duplicate header names through proto round-trip (bytes format)", () => {
		const batch = Proto.ReadBatch.create({
			records: [
				Proto.SequencedRecord.create({
					seqNum: 1n,
					timestamp: 1000n,
					headers: [
						makeHeader("x-key", "value-1"),
						makeHeader("x-key", "value-2"),
						makeHeader("x-key", "value-3"),
					],
					body: textEncoder.encode("body"),
				}),
			],
		});

		const decoded = roundTripReadBatch(batch);
		const record = decoded.records[0];

		// Headers should be an array of tuples, preserving all three entries
		expect(record.headers).toHaveLength(3);

		// Each header is a [Uint8Array, Uint8Array] tuple (bytes format from decodeProtoReadBatch)
		const headerNames = record.headers!.map(([name]) =>
			new TextDecoder().decode(name as Uint8Array),
		);
		const headerValues = record.headers!.map(([, value]) =>
			new TextDecoder().decode(value as Uint8Array),
		);

		expect(headerNames).toEqual(["x-key", "x-key", "x-key"]);
		expect(headerValues).toEqual(["value-1", "value-2", "value-3"]);
	});

	it("preserves headers with unique names through proto round-trip", () => {
		const batch = Proto.ReadBatch.create({
			records: [
				Proto.SequencedRecord.create({
					seqNum: 2n,
					timestamp: 2000n,
					headers: [
						makeHeader("content-type", "application/json"),
						makeHeader("x-request-id", "abc-123"),
					],
					body: textEncoder.encode("{}"),
				}),
			],
		});

		const decoded = roundTripReadBatch(batch);
		const record = decoded.records[0];

		expect(record.headers).toHaveLength(2);

		const headerPairs = record.headers!.map(([name, value]) => [
			new TextDecoder().decode(name as Uint8Array),
			new TextDecoder().decode(value as Uint8Array),
		]);
		expect(headerPairs).toEqual([
			["content-type", "application/json"],
			["x-request-id", "abc-123"],
		]);
	});

	it("handles records with no headers", () => {
		const batch = Proto.ReadBatch.create({
			records: [
				Proto.SequencedRecord.create({
					seqNum: 3n,
					timestamp: 3000n,
					headers: [],
					body: textEncoder.encode("no headers"),
				}),
			],
		});

		const decoded = roundTripReadBatch(batch);
		const record = decoded.records[0];

		expect(record.headers).toEqual([]);
	});

	it("headers are array-of-tuples, not an object", () => {
		const batch = Proto.ReadBatch.create({
			records: [
				Proto.SequencedRecord.create({
					seqNum: 4n,
					timestamp: 4000n,
					headers: [
						makeHeader("dup", "a"),
						makeHeader("dup", "b"),
					],
					body: textEncoder.encode("test"),
				}),
			],
		});

		const decoded = roundTripReadBatch(batch);
		const record = decoded.records[0];

		// Verify the headers are an Array (not a plain object)
		expect(Array.isArray(record.headers)).toBe(true);
		// Each element should be an array (tuple), not an object entry
		for (const header of record.headers!) {
			expect(Array.isArray(header)).toBe(true);
			expect(header).toHaveLength(2);
		}
	});
});

// --- uint64 precision through proto decode path ------------------------------

describe("uint64 precision in proto decode path (issue #114)", () => {
	it("decodeProtoReadBatch converts safe seq_num and timestamp correctly", () => {
		const batch = Proto.ReadBatch.create({
			records: [
				Proto.SequencedRecord.create({
					seqNum: 42n,
					timestamp: 1700000000000n,
					headers: [],
					body: textEncoder.encode("hello"),
				}),
			],
		});

		const decoded = roundTripReadBatch(batch);
		const record = decoded.records[0];

		expect(record.seq_num).toBe(42);
		expect(record.timestamp).toBe(1700000000000);
	});

	it("decodeProtoReadBatch throws for seq_num exceeding MAX_SAFE_INTEGER", () => {
		const unsafeSeqNum = BigInt(Number.MAX_SAFE_INTEGER) + 1n;

		const batch = Proto.ReadBatch.create({
			records: [
				Proto.SequencedRecord.create({
					seqNum: unsafeSeqNum,
					timestamp: 1000n,
					headers: [],
					body: new Uint8Array(),
				}),
			],
		});

		expect(() => roundTripReadBatch(batch)).toThrow(/exceeds JavaScript Number.MAX_SAFE_INTEGER/);
	});

	it("protoAppendAckToJson throws for unsafe seq_num in positions", () => {
		const unsafeSeqNum = BigInt(Number.MAX_SAFE_INTEGER) + 1n;

		const ack = Proto.AppendAck.create({
			start: Proto.StreamPosition.create({
				seqNum: unsafeSeqNum,
				timestamp: 1000n,
			}),
			end: Proto.StreamPosition.create({
				seqNum: 1n,
				timestamp: 1000n,
			}),
			tail: Proto.StreamPosition.create({
				seqNum: 2n,
				timestamp: 1000n,
			}),
		});

		expect(() => protoAppendAckToJson(ack)).toThrow(/exceeds JavaScript Number.MAX_SAFE_INTEGER/);
	});

	it("protoAppendAckToJson succeeds for safe values", () => {
		const ack = Proto.AppendAck.create({
			start: Proto.StreamPosition.create({
				seqNum: 100n,
				timestamp: 1700000000000n,
			}),
			end: Proto.StreamPosition.create({
				seqNum: 105n,
				timestamp: 1700000001000n,
			}),
			tail: Proto.StreamPosition.create({
				seqNum: 106n,
				timestamp: 1700000001000n,
			}),
		});

		const result = protoAppendAckToJson(ack);

		expect(result.start.seqNum).toBe(100);
		expect(result.end.seqNum).toBe(105);
		expect(result.tail.seqNum).toBe(106);
		expect(result.start.timestamp).toBeInstanceOf(Date);
		expect(result.start.timestamp.getTime()).toBe(1700000000000);
	});

	it("decodeProtoReadBatch converts MAX_SAFE_INTEGER seq_num exactly", () => {
		const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);

		const batch = Proto.ReadBatch.create({
			records: [
				Proto.SequencedRecord.create({
					seqNum: maxSafe,
					timestamp: 0n,
					headers: [],
					body: new Uint8Array(),
				}),
			],
		});

		const decoded = roundTripReadBatch(batch);
		expect(decoded.records[0].seq_num).toBe(Number.MAX_SAFE_INTEGER);
	});
});

// --- S2S convertProtoRecord (regression #114) --------------------------------

describe("S2S convertProtoRecord preserves duplicate headers", () => {
	it("preserves duplicate headers in string format", () => {
		const record = {
			seqNum: 10n,
			timestamp: 5000n,
			headers: [
				{
					name: textEncoder.encode("x-key"),
					value: textEncoder.encode("val-1"),
				},
				{
					name: textEncoder.encode("x-key"),
					value: textEncoder.encode("val-2"),
				},
				{
					name: textEncoder.encode("x-key"),
					value: textEncoder.encode("val-3"),
				},
			],
			body: textEncoder.encode("hello"),
		};

		const converted = convertProtoRecord(record, "string");

		expect(converted.headers).toHaveLength(3);
		expect(converted.headers).toEqual([
			["x-key", "val-1"],
			["x-key", "val-2"],
			["x-key", "val-3"],
		]);
	});

	it("preserves duplicate headers in bytes format", () => {
		const record = {
			seqNum: 10n,
			timestamp: 5000n,
			headers: [
				{
					name: textEncoder.encode("x-key"),
					value: textEncoder.encode("val-1"),
				},
				{
					name: textEncoder.encode("x-key"),
					value: textEncoder.encode("val-2"),
				},
			],
			body: textEncoder.encode("hello"),
		};

		const converted = convertProtoRecord(record, "bytes");

		expect(converted.headers).toHaveLength(2);
		const names = converted.headers!.map(([n]) =>
			new TextDecoder().decode(n as Uint8Array),
		);
		expect(names).toEqual(["x-key", "x-key"]);
	});

	it("uses bigintToSafeNumber for seq_num and timestamp", () => {
		const unsafeSeqNum = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
		const record = {
			seqNum: unsafeSeqNum,
			timestamp: 1000n,
			headers: [],
			body: textEncoder.encode("test"),
		};

		expect(() => convertProtoRecord(record, "string")).toThrow(
			/exceeds JavaScript Number.MAX_SAFE_INTEGER/,
		);
	});

	it("decodes string body correctly", () => {
		const record = {
			seqNum: 1n,
			timestamp: 1000n,
			headers: [],
			body: textEncoder.encode("hello world"),
		};

		const converted = convertProtoRecord(record, "string");
		expect(converted.body).toBe("hello world");
	});

	it("keeps binary body in bytes format", () => {
		const body = new Uint8Array([0xff, 0x00, 0xab]);
		const record = {
			seqNum: 1n,
			timestamp: 1000n,
			headers: [],
			body,
		};

		const converted = convertProtoRecord(record, "bytes");
		expect(converted.body).toBe(body);
	});
});

// --- Cross-transport consistency ---------------------------------------------

describe("cross-transport consistency: fetch/proto vs S2S produce same shapes", () => {
	it("produces matching fields for the same protobuf input", () => {
		// Build a protobuf record
		const proto = Proto.ReadBatch.create({
			records: [
				Proto.SequencedRecord.create({
					seqNum: 42n,
					timestamp: 1700000000000n,
					headers: [
						makeHeader("content-type", "application/json"),
						makeHeader("x-trace", "abc"),
						makeHeader("x-trace", "def"),
					],
					body: textEncoder.encode("test body"),
				}),
			],
		});

		// Path 1: Fetch/proto decode (returns bytes format)
		const fetchResult = roundTripReadBatch(proto);
		const fetchRecord = fetchResult.records[0];

		// Path 2: S2S convertProtoRecord (also test bytes format for comparison)
		const s2sRecord = convertProtoRecord(
			{
				seqNum: 42n,
				timestamp: 1700000000000n,
				headers: [
					{
						name: textEncoder.encode("content-type"),
						value: textEncoder.encode("application/json"),
					},
					{
						name: textEncoder.encode("x-trace"),
						value: textEncoder.encode("abc"),
					},
					{
						name: textEncoder.encode("x-trace"),
						value: textEncoder.encode("def"),
					},
				],
				body: textEncoder.encode("test body"),
			},
			"bytes",
		);

		// Both should have the same seq_num and timestamp
		expect(fetchRecord.seq_num).toBe(s2sRecord.seq_num);
		expect(fetchRecord.seq_num).toBe(42);
		// Timestamps: proto.ts uses Number() for timestamp in fromProtoPosition,
		// while S2S uses bigintToSafeNumber. Both produce the same value for
		// safe integers. Timestamps are milliseconds since Unix epoch.
		expect(fetchRecord.timestamp).toBe(s2sRecord.timestamp);
		expect(fetchRecord.timestamp).toBe(1700000000000);

		// Both should preserve all 3 headers (including duplicates)
		expect(fetchRecord.headers).toHaveLength(3);
		expect(s2sRecord.headers).toHaveLength(3);

		// Both should have the same body
		expect(new TextDecoder().decode(fetchRecord.body as Uint8Array)).toBe(
			"test body",
		);
		expect(new TextDecoder().decode(s2sRecord.body as Uint8Array)).toBe(
			"test body",
		);
	});

	it("S2S string format matches fetch JSON shape for headers", () => {
		// S2S string-format record
		const s2sString = convertProtoRecord(
			{
				seqNum: 1n,
				timestamp: 1000n,
				headers: [
					{
						name: textEncoder.encode("key"),
						value: textEncoder.encode("val1"),
					},
					{
						name: textEncoder.encode("key"),
						value: textEncoder.encode("val2"),
					},
				],
				body: textEncoder.encode("body"),
			},
			"string",
		);

		// Headers should be array-of-tuples (not an object)
		expect(Array.isArray(s2sString.headers)).toBe(true);
		expect(s2sString.headers).toEqual([
			["key", "val1"],
			["key", "val2"],
		]);
		expect(typeof s2sString.body).toBe("string");
		expect(s2sString.body).toBe("body");
	});
});

// --- Combined: duplicate headers + correct field conversion ------------------

describe("full decode path preserves headers and converts fields", () => {
	it("handles a batch with multiple records, some having duplicate headers", () => {
		const batch = Proto.ReadBatch.create({
			records: [
				Proto.SequencedRecord.create({
					seqNum: 10n,
					timestamp: 5000n,
					headers: [
						makeHeader("trace-id", "abc"),
						makeHeader("trace-id", "def"),
					],
					body: textEncoder.encode("record-1"),
				}),
				Proto.SequencedRecord.create({
					seqNum: 11n,
					timestamp: 5001n,
					headers: [makeHeader("unique", "value")],
					body: textEncoder.encode("record-2"),
				}),
			],
			tail: Proto.StreamPosition.create({
				seqNum: 12n,
				timestamp: 5001n,
			}),
		});

		const decoded = roundTripReadBatch(batch);

		// First record has duplicate headers preserved
		expect(decoded.records[0].seq_num).toBe(10);
		expect(decoded.records[0].headers).toHaveLength(2);
		const firstRecordHeaderValues = decoded.records[0].headers!.map(
			([, v]) => new TextDecoder().decode(v as Uint8Array),
		);
		expect(firstRecordHeaderValues).toEqual(["abc", "def"]);

		// Second record
		expect(decoded.records[1].seq_num).toBe(11);
		expect(decoded.records[1].headers).toHaveLength(1);

		// Tail is decoded
		expect(decoded.tail).toBeDefined();
		expect(decoded.tail!.seq_num).toBe(12);
	});
});
