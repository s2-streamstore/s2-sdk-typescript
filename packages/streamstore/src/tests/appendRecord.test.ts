import { describe, expect, it } from "vitest";
import { AppendInput, AppendRecord, MAX_APPEND_BYTES } from "../types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("AppendRecord.bytes with string headers", () => {
	it("encodes string header names and values as UTF-8", () => {
		const record = AppendRecord.bytes({
			body: new Uint8Array([1, 2, 3]),
			headers: [["kind", "event-chunk"]],
		});

		expect(record.headers).toHaveLength(1);
		const [name, value] = record.headers![0]!;
		expect(name).toBeInstanceOf(Uint8Array);
		expect(value).toBeInstanceOf(Uint8Array);
		expect(decoder.decode(name)).toBe("kind");
		expect(decoder.decode(value)).toBe("event-chunk");
	});

	it("accepts mixed string and Uint8Array header elements", () => {
		const record = AppendRecord.bytes({
			body: new Uint8Array([1]),
			headers: [
				["kind", encoder.encode("binary-value")],
				[encoder.encode("envelope"), "v1"],
			],
		});

		expect(decoder.decode(record.headers![0]![0])).toBe("kind");
		expect(decoder.decode(record.headers![0]![1])).toBe("binary-value");
		expect(decoder.decode(record.headers![1]![0])).toBe("envelope");
		expect(decoder.decode(record.headers![1]![1])).toBe("v1");
	});

	it("meters string headers by UTF-8 byte length", () => {
		const stringHeaders = AppendRecord.bytes({
			body: new Uint8Array(5),
			headers: [["emoji", "🚀"]],
		});
		const bytesHeaders = AppendRecord.bytes({
			body: new Uint8Array(5),
			headers: [[encoder.encode("emoji"), encoder.encode("🚀")]],
		});

		expect(stringHeaders.meteredBytes).toBe(bytesHeaders.meteredBytes);
		// overhead 8 + 2*1, headers "emoji" = 5 + "🚀" = 4, body 5
		expect(stringHeaders.meteredBytes).toBe(24);
	});
});

describe("AppendRecord.maxBodyBytes", () => {
	it("returns the full budget minus record overhead when there are no headers", () => {
		expect(AppendRecord.maxBodyBytes()).toBe(MAX_APPEND_BYTES - 8);
		expect(AppendRecord.maxBodyBytes([])).toBe(MAX_APPEND_BYTES - 8);
	});

	it("accounts for string and bytes headers", () => {
		// 8 + 2*2 + ("kind" 4 + "event-chunk" 11) + (3 + 2) = 32
		const headers: Array<[string | Uint8Array, string | Uint8Array]> = [
			["kind", "event-chunk"],
			[encoder.encode("abc"), encoder.encode("de")],
		];
		expect(AppendRecord.maxBodyBytes(headers)).toBe(MAX_APPEND_BYTES - 32);
	});

	it("yields a body size that exactly fills a single-record batch", () => {
		const headers: Array<[string, string]> = [["envelope", "v1"]];
		const max = AppendRecord.maxBodyBytes(headers);

		const record = AppendRecord.bytes({
			body: new Uint8Array(max),
			headers,
		});
		expect(record.meteredBytes).toBe(MAX_APPEND_BYTES);
		expect(() => AppendInput.create([record])).not.toThrow();

		const oversized = AppendRecord.bytes({
			body: new Uint8Array(max + 1),
			headers,
		});
		expect(() => AppendInput.create([oversized])).toThrow();
	});
});
