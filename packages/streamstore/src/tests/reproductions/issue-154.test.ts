import { describe, expect, it } from "vitest";
import { RangeNotSatisfiableError, S2Error } from "../../error.js";

/**
 * Issue #154: SDK SSE read session crashes when server returns non-JSON error responses.
 *
 * The `in` operator throws TypeError when the right operand is a primitive (string).
 * The generated client sets `response.error = jsonError ?? textError`, so when the
 * server returns a non-JSON body, `response.error` is a plain string.
 *
 * The fix adds a type guard (`typeof err === "object" && err !== null`) before
 * using `"message" in err`, matching the pattern in `withS2Error` in error.ts.
 */

/**
 * Simulate the error-handling logic from FetchReadSession.create to verify
 * that both string and object errors are handled without throwing TypeError.
 */
function simulateReadSessionErrorHandling(
	responseError: unknown,
	status: number,
	statusText: string,
): S2Error {
	// This mirrors the fixed code path from FetchReadSession.create (line ~80)
	const error =
		typeof responseError === "object" &&
		responseError !== null &&
		"message" in responseError
			? new S2Error({
					message: (responseError as { message: string }).message,
					code:
						(responseError as { code?: string }).code ?? undefined,
					status,
				})
			: status === 416
				? new RangeNotSatisfiableError({
						status,
					})
				: new S2Error({
						message: statusText ?? "Request failed",
						status,
					});
	return error;
}

describe("Issue #154: non-object error responses should not crash", () => {
	it("handles string error (non-JSON response body) gracefully", () => {
		// When the server returns a non-JSON body, the generated client sets
		// response.error to the raw text string.
		const result = simulateReadSessionErrorHandling(
			"Bad Gateway",
			502,
			"Bad Gateway",
		);

		expect(result).toBeInstanceOf(S2Error);
		expect(result.message).toBe("Bad Gateway");
		expect(result.status).toBe(502);
	});

	it("handles object error with message correctly", () => {
		// When the server returns a JSON body with { message, code }, the
		// generated client parses it into an object.
		const result = simulateReadSessionErrorHandling(
			{ message: "Stream not found", code: "NOT_FOUND" },
			404,
			"Not Found",
		);

		expect(result).toBeInstanceOf(S2Error);
		expect(result.message).toBe("Stream not found");
		expect(result.code).toBe("NOT_FOUND");
		expect(result.status).toBe(404);
	});

	it("handles 416 status with string error as RangeNotSatisfiableError", () => {
		// When the server returns 416 with a non-JSON body, we should still
		// get RangeNotSatisfiableError (not a TypeError crash).
		const result = simulateReadSessionErrorHandling(
			"Requested Range Not Satisfiable",
			416,
			"Range Not Satisfiable",
		);

		expect(result).toBeInstanceOf(RangeNotSatisfiableError);
		expect(result).toBeInstanceOf(S2Error);
		expect(result.status).toBe(416);
	});

	it("handles null error gracefully", () => {
		// Edge case: null should not crash the in operator either.
		// typeof null === "object" is true, so we need the !== null guard.
		const result = simulateReadSessionErrorHandling(
			null,
			500,
			"Internal Server Error",
		);

		expect(result).toBeInstanceOf(S2Error);
		expect(result.message).toBe("Internal Server Error");
		expect(result.status).toBe(500);
	});

	it("the old code would have thrown TypeError on string error", () => {
		// Verify that the in operator on a string throws TypeError,
		// confirming the bug existed before the fix.
		expect(() => {
			"message" in ("Bad Gateway" as any);
		}).toThrow(TypeError);
	});
});
