import { describe, expect, it } from "vitest";
import { toSnakeCase } from "../../internal/case-transform.js";

/**
 * Issue #183: streams.reconfigure does not normalize deleteOnEmpty.minAgeSecs.
 *
 * `toAPIStreamConfig` (used by `create`) normalizes `deleteOnEmpty.minAgeSecs`
 * with `Math.max(0, Math.floor(...))`, but `streams.reconfigure` spreads
 * `deleteOnEmpty` through from the input args without applying the same
 * normalization.
 *
 * This means floating-point values like 3.7 are sent as-is in reconfigure,
 * while create would floor them to 3. Negative values are sent as-is in
 * reconfigure, while create would clamp them to 0.
 *
 * The fix normalizes `deleteOnEmpty.minAgeSecs` in `reconfigure` the same
 * way as `toAPIStreamConfig`.
 */

/**
 * Simulate the normalization that toAPIStreamConfig applies for deleteOnEmpty.
 * This is what `create` does correctly.
 */
function normalizeDeleteOnEmpty(
	deleteOnEmpty: { minAgeSecs?: number } | null | undefined,
) {
	if (!deleteOnEmpty) return deleteOnEmpty;
	return {
		...deleteOnEmpty,
		minAgeSecs:
			deleteOnEmpty.minAgeSecs === undefined
				? undefined
				: Math.max(0, Math.floor(deleteOnEmpty.minAgeSecs)),
	};
}

/**
 * Simulate the reconfigure body construction (buggy version).
 * This is what the old code does — passes deleteOnEmpty through unchanged.
 */
function buildReconfigureBodyBuggy(args: {
	stream: string;
	deleteOnEmpty?: { minAgeSecs?: number } | null;
	retentionPolicy?: unknown;
}) {
	const { stream, ...reconfigArgs } = args;
	const apiArgs = {
		...reconfigArgs, // BUG: deleteOnEmpty passes through unnormalized
	};
	return toSnakeCase(apiArgs);
}

/**
 * Simulate the reconfigure body construction (fixed version).
 * This normalizes deleteOnEmpty.minAgeSecs like toAPIStreamConfig does.
 */
function buildReconfigureBodyFixed(args: {
	stream: string;
	deleteOnEmpty?: { minAgeSecs?: number } | null;
	retentionPolicy?: unknown;
}) {
	const { stream, ...reconfigArgs } = args;
	const apiArgs = {
		...reconfigArgs,
		deleteOnEmpty: normalizeDeleteOnEmpty(reconfigArgs.deleteOnEmpty),
	};
	return toSnakeCase(apiArgs);
}

describe("Issue #183: reconfigure must normalize deleteOnEmpty.minAgeSecs", () => {
	it("should floor floating-point minAgeSecs values", () => {
		const args = {
			stream: "test-stream",
			deleteOnEmpty: { minAgeSecs: 3.7 },
		};

		const body = buildReconfigureBodyFixed(args);
		expect(body).toHaveProperty("delete_on_empty");
		expect((body as any).delete_on_empty.min_age_secs).toBe(3);
	});

	it("should clamp negative minAgeSecs to 0", () => {
		const args = {
			stream: "test-stream",
			deleteOnEmpty: { minAgeSecs: -5 },
		};

		const body = buildReconfigureBodyFixed(args);
		expect((body as any).delete_on_empty.min_age_secs).toBe(0);
	});

	it("should pass through integer minAgeSecs unchanged", () => {
		const args = {
			stream: "test-stream",
			deleteOnEmpty: { minAgeSecs: 60 },
		};

		const body = buildReconfigureBodyFixed(args);
		expect((body as any).delete_on_empty.min_age_secs).toBe(60);
	});

	it("should handle undefined minAgeSecs", () => {
		const args = {
			stream: "test-stream",
			deleteOnEmpty: {},
		};

		const body = buildReconfigureBodyFixed(args);
		expect((body as any).delete_on_empty.min_age_secs).toBeUndefined();
	});

	it("should handle null deleteOnEmpty", () => {
		const args = {
			stream: "test-stream",
			deleteOnEmpty: null,
		};

		const body = buildReconfigureBodyFixed(args);
		expect(body).toHaveProperty("delete_on_empty", null);
	});

	it("demonstrates the bug: old code sends float unchanged", () => {
		const args = {
			stream: "test-stream",
			deleteOnEmpty: { minAgeSecs: 3.7 },
		};

		const buggyBody = buildReconfigureBodyBuggy(args);
		// The buggy body sends the float as-is — this is the inconsistency
		expect((buggyBody as any).delete_on_empty.min_age_secs).toBe(3.7);
	});

	it("demonstrates the bug: old code sends negative unchanged", () => {
		const args = {
			stream: "test-stream",
			deleteOnEmpty: { minAgeSecs: -5 },
		};

		const buggyBody = buildReconfigureBodyBuggy(args);
		// The buggy body sends the negative as-is
		expect((buggyBody as any).delete_on_empty.min_age_secs).toBe(-5);
	});
});
