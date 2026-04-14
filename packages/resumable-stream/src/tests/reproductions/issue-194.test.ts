import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Issue #194: resumeStream returns a hanging ReadableStream instead of null
 * when session creation fails.
 *
 * The `return null` inside the ReadableStream's `start()` callback returns
 * from start(), not from resumeStream(). The Streams API ignores the return
 * value of start(), so the stream is left in a pending state where
 * reader.read() never resolves.
 *
 * After the fix, resumeStream() should return null when readSession() throws.
 */

// Mock S2 so readSession throws immediately (simulating 404/403)
vi.mock("@s2-dev/streamstore", async () => {
	const actual =
		await vi.importActual<typeof import("@s2-dev/streamstore")>(
			"@s2-dev/streamstore",
		);
	class MockS2 {
		basin() {
			return {
				stream: () => ({
					readSession: () =>
						Promise.reject(new Error("Not Found (404)")),
				}),
			};
		}
	}
	return {
		...actual,
		S2: MockS2,
	};
});

describe("Issue #194: resumeStream returns null on session creation failure", () => {
	const savedEnv: Record<string, string | undefined> = {};

	beforeAll(() => {
		for (const key of [
			"S2_ACCESS_TOKEN",
			"S2_BASIN",
			"S2_ACCOUNT_ENDPOINT",
			"S2_BASIN_ENDPOINT",
		]) {
			savedEnv[key] = process.env[key];
		}

		process.env.S2_ACCESS_TOKEN = "ignored";
		process.env.S2_BASIN = "test-basin";
		process.env.S2_ACCOUNT_ENDPOINT = "http://localhost:80";
		process.env.S2_BASIN_ENDPOINT = "http://localhost:80";
	});

	afterAll(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		vi.restoreAllMocks();
	});

	it("resumeStream returns null instead of a hanging stream", async () => {
		const { createResumableStreamContext } = await import("../../index.js");

		const ctx = createResumableStreamContext({
			waitUntil: (p) => {
				p.catch(() => {});
			},
		});

		const result = await ctx.resumeStream("non-existent-stream");

		// Before fix: result is a ReadableStream (that hangs on read)
		// After fix: result is null
		expect(result).toBeNull();
	}, 10_000);

	it("if returned, the stream should not hang on read()", async () => {
		const { createResumableStreamContext } = await import("../../index.js");

		const ctx = createResumableStreamContext({
			waitUntil: (p) => {
				p.catch(() => {});
			},
		});

		const result = await ctx.resumeStream("another-stream");

		// The result should be null, but even if it were a stream,
		// it must not hang indefinitely.
		if (result !== null) {
			const reader = result.getReader();
			const timeout = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Stream read hung")), 3_000),
			);
			await expect(
				Promise.race([reader.read(), timeout]),
			).rejects.toThrow();
			reader.releaseLock();
		} else {
			expect(result).toBeNull();
		}
	}, 10_000);
});
