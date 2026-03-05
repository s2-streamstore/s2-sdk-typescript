import { describe, expect, it } from "vitest";
import { s2Error, S2Error } from "../../error.js";

describe("Issue #141 reproduction", () => {
	describe("genuine connection errors are correctly identified", () => {
		it("Node.js: 'fetch failed'", () => {
			const result = s2Error(new Error("fetch failed"));
			expect(result).toBeInstanceOf(S2Error);
			expect(result.status).toBe(502);
		});

		it("Chrome: 'Failed to fetch'", () => {
			const result = s2Error(new Error("Failed to fetch"));
			expect(result).toBeInstanceOf(S2Error);
			expect(result.status).toBe(502);
		});

		it("Firefox: 'NetworkError when attempting to fetch resource'", () => {
			const result = s2Error(
				new Error("NetworkError when attempting to fetch resource"),
			);
			expect(result).toBeInstanceOf(S2Error);
			expect(result.status).toBe(502);
		});

		it("Safari: 'Load failed'", () => {
			const result = s2Error(new Error("Load failed"));
			expect(result).toBeInstanceOf(S2Error);
			expect(result.status).toBe(502);
		});
	});

	describe("messages with trailing punctuation are still matched", () => {
		it("Firefox with trailing period: 'NetworkError when attempting to fetch resource.'", () => {
			const result = s2Error(
				new Error("NetworkError when attempting to fetch resource."),
			);
			expect(result).toBeInstanceOf(S2Error);
			expect(result.status).toBe(502);
		});

		it("trailing whitespace: 'fetch failed '", () => {
			const result = s2Error(new Error("fetch failed "));
			expect(result).toBeInstanceOf(S2Error);
			expect(result.status).toBe(502);
		});
	});

	describe("messages containing connection substrings with additional context are NOT misclassified", () => {
		it("should not match 'Stream failed to fetch not found'", () => {
			const result = s2Error(
				new Error("Stream 'failed to fetch' not found"),
			);
			expect(result).toBeInstanceOf(S2Error);
			expect(result.status).not.toBe(502);
		});

		it("should not match 'Operation failed to fetch data from cache'", () => {
			const result = s2Error(
				new Error("Operation failed to fetch data from cache"),
			);
			expect(result).toBeInstanceOf(S2Error);
			expect(result.status).not.toBe(502);
		});

		it("should not match 'The networkerror handler triggered'", () => {
			const result = s2Error(
				new Error("The networkerror handler triggered"),
			);
			expect(result).toBeInstanceOf(S2Error);
			expect(result.status).not.toBe(502);
		});

		it("should not match 'Image load failed for large payload'", () => {
			const result = s2Error(
				new Error("Image load failed for large payload"),
			);
			expect(result).toBeInstanceOf(S2Error);
			expect(result.status).not.toBe(502);
		});
	});
});
