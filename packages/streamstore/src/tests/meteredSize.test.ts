import { describe, expect, it } from "vitest";
import { AppendRecord, meteredBytes } from "../utils.js";

describe("meteredSizeBytes", () => {
	it("calculates size for string format records", () => {
		const record = AppendRecord.make("hello", [
			["foo", "bar"],
			["baz", "qux"],
		]);

		const size = meteredBytes(record);

		// body: "hello" = 5 bytes
		// headers: "foo" = 3, "bar" = 3, "baz" = 3, "qux" = 3 = 12 bytes
		// overhead: 8 + 2*2 (2 headers) = 12 bytes
		// Total: 8 + 4 + 12 + 5 = 29 bytes
		expect(size).toBe(29);
	});

	it("calculates size for string format with UTF-8 characters", () => {
		const record = AppendRecord.make("hello 世界", [["emoji", "🚀"]]);

		const size = meteredBytes(record);

		// body: "hello 世界" = 12 bytes (hello + space = 6, 世 = 3, 界 = 3)
		// headers: "emoji" = 5, "🚀" = 4 = 9 bytes
		// overhead: 8 + 2*1 (1 header) = 10 bytes
		// Total: 8 + 2 + 9 + 12 = 31 bytes
		expect(size).toBe(31);
	});

	it("calculates size for bytes format records", () => {
		const record = AppendRecord.make(new Uint8Array([1, 2, 3, 4, 5]), [
			[new Uint8Array([10, 20]), new Uint8Array([30, 40, 50])],
		]);

		const size = meteredBytes(record);

		// body: 5 bytes
		// headers: key 2 bytes, value 3 bytes = 5 bytes
		// overhead: 8 + 2*1 (1 header) = 10 bytes
		// Total: 8 + 2 + 5 + 5 = 20 bytes
		expect(size).toBe(20);
	});

	it("calculates size for record with no body", () => {
		const record = AppendRecord.make(undefined, [["foo", "bar"]]);

		const size = meteredBytes(record);

		// body: 0 bytes
		// headers: "foo" = 3, "bar" = 3 = 6 bytes
		// overhead: 8 + 2*1 (1 header) = 10 bytes
		// Total: 8 + 2 + 6 + 0 = 16 bytes
		expect(size).toBe(16);
	});

	it("calculates size for record with no headers", () => {
		const record = AppendRecord.make("hello");

		const size = meteredBytes(record);

		// body: "hello" = 5 bytes
		// headers: 0 bytes
		// overhead: 8 + 2*0 = 8 bytes
		// Total: 8 + 0 + 0 + 5 = 13 bytes
		expect(size).toBe(13);
	});

	it("calculates size for empty record", () => {
		const record = AppendRecord.make();

		const size = meteredBytes(record);

		// body: 0 bytes
		// headers: 0 bytes
		// overhead: 8 + 2*0 = 8 bytes
		// Total: 8 bytes
		expect(size).toBe(8);
	});

	it("calculates size for command records", () => {
		const fenceRecord = AppendRecord.fence("my-token");
		const size = meteredBytes(fenceRecord);

		// body: "my-token" = 8 bytes
		// headers: "" = 0, "fence" = 5 = 5 bytes
		// overhead: 8 + 2*1 (1 header) = 10 bytes
		// Total: 8 + 2 + 5 + 8 = 23 bytes
		expect(size).toBe(23);
	});

	it("calculates size for trim command (bytes format)", () => {
		const trimRecord = AppendRecord.trim(123);
		const size = meteredBytes(trimRecord);

		// body: 8 bytes (BigInt as Uint8Array)
		// headers: empty Uint8Array = 0, "trim" as bytes = 4 = 4 bytes
		// overhead: 8 + 2*1 (1 header) = 10 bytes
		// Total: 8 + 2 + 4 + 8 = 22 bytes
		expect(size).toBe(22);
	});
});
