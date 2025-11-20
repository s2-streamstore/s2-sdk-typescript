import { describe, expect, it } from "vitest";
import { utf8ByteLength } from "../utils.js";

describe("utf8ByteLength", () => {
	// Helper to get actual UTF-8 byte length using TextEncoder
	const actualByteLength = (str: string): number => {
		return new TextEncoder().encode(str).length;
	};

	it("calculates byte length for ASCII characters (1 byte each)", () => {
		const testCases = [
			"",
			"a",
			"hello",
			"Hello, World!",
			"0123456789",
			"ASCII only: !@#$%^&*()",
		];

		for (const str of testCases) {
			expect(utf8ByteLength(str)).toBe(actualByteLength(str));
		}
	});

	it("calculates byte length for Latin-1 Supplement characters (2 bytes)", () => {
		const testCases = [
			"café", // é = U+00E9 (2 bytes)
			"naïve", // ï = U+00EF (2 bytes)
			"Zürich", // ü = U+00FC (2 bytes)
			"€100", // € = U+20AC (3 bytes actually, but testing mixed)
			"©2024", // © = U+00A9 (2 bytes)
		];

		for (const str of testCases) {
			expect(utf8ByteLength(str)).toBe(actualByteLength(str));
		}
	});

	it("calculates byte length for CJK characters (3 bytes each)", () => {
		const testCases = [
			"世界", // Chinese: 2 chars × 3 bytes = 6 bytes
			"日本語", // Japanese: 3 chars × 3 bytes = 9 bytes
			"한글", // Korean: 2 chars × 3 bytes = 6 bytes
			"你好世界", // Chinese: 4 chars × 3 bytes = 12 bytes
			"hello 世界", // Mixed: 6 ASCII (6 bytes) + 2 CJK (6 bytes) = 12 bytes
		];

		for (const str of testCases) {
			expect(utf8ByteLength(str)).toBe(actualByteLength(str));
		}
	});

	it("calculates byte length for emoji (4 bytes via surrogate pairs)", () => {
		const testCases = [
			"🚀", // U+1F680 (surrogate pair: 4 bytes)
			"😀", // U+1F600 (surrogate pair: 4 bytes)
			"🎉", // U+1F389 (surrogate pair: 4 bytes)
			"👍", // U+1F44D (surrogate pair: 4 bytes)
			"🌟", // U+1F31F (surrogate pair: 4 bytes)
			"hello 🚀", // 6 ASCII + 4 emoji = 10 bytes
		];

		for (const str of testCases) {
			expect(utf8ByteLength(str)).toBe(actualByteLength(str));
		}
	});

	it("calculates byte length for multiple emoji", () => {
		const testCases = [
			"🚀🎉", // 2 emoji × 4 bytes = 8 bytes
			"😀😃😄", // 3 emoji × 4 bytes = 12 bytes
			"🌍🌎🌏", // 3 emoji × 4 bytes = 12 bytes
		];

		for (const str of testCases) {
			expect(utf8ByteLength(str)).toBe(actualByteLength(str));
		}
	});

	it("calculates byte length for mixed Unicode content", () => {
		const testCases = [
			"Hello 世界 🚀", // ASCII + CJK + emoji
			"Café ☕ 日本", // Latin + emoji + CJK
			"Price: €50 💰", // ASCII + currency + emoji
			"2024年 🎉", // ASCII + CJK + emoji
		];

		for (const str of testCases) {
			expect(utf8ByteLength(str)).toBe(actualByteLength(str));
		}
	});

	it("calculates byte length for Arabic and RTL text (3 bytes)", () => {
		const testCases = [
			"مرحبا", // Arabic: 5 chars × ~3 bytes (varies)
			"שלום", // Hebrew: 4 chars × ~3 bytes
		];

		for (const str of testCases) {
			expect(utf8ByteLength(str)).toBe(actualByteLength(str));
		}
	});

	it("calculates byte length for special Unicode characters", () => {
		const testCases = [
			"™", // U+2122 (3 bytes)
			"®", // U+00AE (2 bytes)
			"°", // U+00B0 (2 bytes)
			"±", // U+00B1 (2 bytes)
			"×", // U+00D7 (2 bytes)
			"÷", // U+00F7 (2 bytes)
			"π", // U+03C0 (2 bytes)
			"∞", // U+221E (3 bytes)
		];

		for (const str of testCases) {
			expect(utf8ByteLength(str)).toBe(actualByteLength(str));
		}
	});

	it("handles empty string", () => {
		expect(utf8ByteLength("")).toBe(0);
		expect(utf8ByteLength("")).toBe(actualByteLength(""));
	});

	it("handles newlines and whitespace", () => {
		const testCases = [
			"\n",
			"\r\n",
			"\t",
			"  ",
			"hello\nworld",
			"line1\r\nline2",
		];

		for (const str of testCases) {
			expect(utf8ByteLength(str)).toBe(actualByteLength(str));
		}
	});

	it("handles very long strings", () => {
		const longAscii = "a".repeat(10000);
		expect(utf8ByteLength(longAscii)).toBe(actualByteLength(longAscii));

		const longUnicode = "世".repeat(1000);
		expect(utf8ByteLength(longUnicode)).toBe(actualByteLength(longUnicode));

		const longEmoji = "🚀".repeat(500);
		expect(utf8ByteLength(longEmoji)).toBe(actualByteLength(longEmoji));
	});

	it("handles strings with null bytes", () => {
		const testCases = ["hello\x00world", "\x00", "start\x00middle\x00end"];

		for (const str of testCases) {
			expect(utf8ByteLength(str)).toBe(actualByteLength(str));
		}
	});

	it("handles all ASCII printable characters", () => {
		// ASCII printable: space (32) to tilde (126)
		const allPrintable = Array.from({ length: 95 }, (_, i) =>
			String.fromCharCode(32 + i),
		).join("");
		expect(utf8ByteLength(allPrintable)).toBe(actualByteLength(allPrintable));
	});

	it("handles boundary cases for UTF-8 encoding", () => {
		// U+007F: Last 1-byte character
		expect(utf8ByteLength("\x7F")).toBe(actualByteLength("\x7F"));

		// U+0080: First 2-byte character
		expect(utf8ByteLength("\u0080")).toBe(actualByteLength("\u0080"));

		// U+07FF: Last 2-byte character
		expect(utf8ByteLength("\u07FF")).toBe(actualByteLength("\u07FF"));

		// U+0800: First 3-byte character
		expect(utf8ByteLength("\u0800")).toBe(actualByteLength("\u0800"));

		// U+FFFF: Last 3-byte character (BMP)
		expect(utf8ByteLength("\uFFFF")).toBe(actualByteLength("\uFFFF"));
	});

	it("handles complex emoji with modifiers and ZWJ sequences", () => {
		const testCases = [
			"👨‍👩‍👧‍👦", // Family emoji (ZWJ sequence)
			"👋🏽", // Waving hand with skin tone modifier
			"🏳️‍🌈", // Rainbow flag (ZWJ sequence)
		];

		for (const str of testCases) {
			expect(utf8ByteLength(str)).toBe(actualByteLength(str));
		}
	});

	// Edge case: unpaired surrogates
	// Note: These are technically invalid UTF-16, but JavaScript allows them
	it("handles unpaired high surrogate (3 bytes replacement)", () => {
		// Manually create an unpaired high surrogate
		const unpairedHigh = String.fromCharCode(0xd800); // High surrogate without pair
		expect(utf8ByteLength(unpairedHigh)).toBe(actualByteLength(unpairedHigh));
	});

	it("handles unpaired low surrogate (3 bytes replacement)", () => {
		// Manually create an unpaired low surrogate
		const unpairedLow = String.fromCharCode(0xdc00); // Low surrogate without pair
		expect(utf8ByteLength(unpairedLow)).toBe(actualByteLength(unpairedLow));
	});

	it("handles unpaired high surrogate at end of string", () => {
		const str = "hello" + String.fromCharCode(0xd800); // High surrogate at end
		expect(utf8ByteLength(str)).toBe(actualByteLength(str));
	});

	it("handles unpaired high surrogate followed by non-surrogate", () => {
		const str = String.fromCharCode(0xd800) + "a"; // High surrogate + ASCII
		expect(utf8ByteLength(str)).toBe(actualByteLength(str));
	});
});
