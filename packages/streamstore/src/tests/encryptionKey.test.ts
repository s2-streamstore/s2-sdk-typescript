import { describe, expect, it } from "vitest";
import { S2Error } from "../error.js";
import { EncryptionKey } from "../index.js";

const KEY_B64 = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=";
const KEY_BYTES = new Uint8Array([
	1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
	23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
]);

describe("EncryptionKey", () => {
	it("trims base64-encoded string input", () => {
		expect(EncryptionKey.from(`  ${KEY_B64}\n`)).toBe(KEY_B64);
	});

	it("encodes raw key material as base64", () => {
		expect(EncryptionKey.fromBytes(KEY_BYTES)).toBe(KEY_B64);
	});

	it("rejects empty and oversized header values", () => {
		expect(() => EncryptionKey.from("   ")).toThrowError(S2Error);
		expect(() => EncryptionKey.from("   ")).toThrow(/length 0 is out of range/);
		expect(() => EncryptionKey.from("A".repeat(45))).toThrow(
			/length 45 is out of range/,
		);
	});
});
