import { describe, expect, it } from "vitest";
import { toCamelCase, toSnakeCase } from "../../internal/case-transform.js";

/**
 * Issue #163: Case conversion utilities corrupt non-plain objects and produce
 * camelCase key mismatches.
 *
 * Two bugs:
 * 1. Non-plain objects (Date, Map, custom classes) are treated as plain objects
 *    and rebuilt via Object.entries(), destroying their prototype/data.
 * 2. snakeToCamelString uses /_([a-z])/g which doesn't match underscores
 *    followed by digits or uppercase, causing runtime keys to diverge from
 *    the type-level SnakeToCamel transformation.
 */

describe("Issue #163: case conversion corrupts non-plain objects", () => {
	it("should preserve Date objects in toCamelCase", () => {
		const date = new Date("2024-01-01");
		const input = { created_at: date };
		const result = toCamelCase<typeof input>(input);
		expect((result as any).createdAt).toBeInstanceOf(Date);
		expect((result as any).createdAt.toISOString()).toBe(date.toISOString());
	});

	it("should preserve Date objects in toSnakeCase", () => {
		const date = new Date("2024-01-01");
		const input = { createdAt: date };
		const result = toSnakeCase<typeof input>(input);
		expect((result as any).created_at).toBeInstanceOf(Date);
		expect((result as any).created_at.toISOString()).toBe(date.toISOString());
	});

	it("should preserve nested Date objects", () => {
		const date = new Date("2024-06-15");
		const input = { stream_info: { last_updated: date } };
		const result = toCamelCase<typeof input>(input);
		expect((result as any).streamInfo.lastUpdated).toBeInstanceOf(Date);
	});
});

describe("Issue #163: snakeToCamelString mismatches type-level conversion", () => {
	it("should handle numeric segments in keys", () => {
		// Type-level: last_7_days → last7Days
		// Bug: runtime produced last_7Days
		const input = { last_7_days: 123 };
		const result = toCamelCase<typeof input>(input);
		expect(result).toHaveProperty("last7Days");
		expect((result as any).last7Days).toBe(123);
	});

	it("should handle double underscores in keys", () => {
		// Type-level: foo__bar → fooBar
		// Bug: runtime produced foo_Bar
		const input = { foo__bar: 123 };
		const result = toCamelCase<typeof input>(input);
		expect(result).toHaveProperty("fooBar");
		expect((result as any).fooBar).toBe(123);
	});

	it("should handle underscore followed by uppercase in keys", () => {
		// Type-level: foo_Bar → fooBar
		// Bug: runtime kept foo_Bar (regex only matched lowercase after _)
		const input = { foo_Bar: 456 };
		const result = toCamelCase<typeof input>(input);
		expect(result).toHaveProperty("fooBar");
		expect((result as any).fooBar).toBe(456);
	});

	it("should still handle standard snake_case keys correctly", () => {
		const input = { seq_num: 1, created_at: "2024-01-01" };
		const result = toCamelCase<typeof input>(input);
		expect(result).toHaveProperty("seqNum");
		expect(result).toHaveProperty("createdAt");
		expect((result as any).seqNum).toBe(1);
		expect((result as any).createdAt).toBe("2024-01-01");
	});
});
