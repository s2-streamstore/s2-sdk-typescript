import { describe, expect, it } from "vitest";
import { S2Error } from "../../error.js";
import type { AppendResult, CloseResult } from "../../lib/result.js";
import { RetryAppendSession } from "../../lib/retry.js";
import type { TransportAppendSession } from "../../lib/stream/types.js";
import { AppendInput, AppendRecord } from "../../types.js";

/**
 * Issue #129: enforce 1 MiB minimum for maxInflightBytes.
 *
 * When a user sets maxInflightBytes below 1 MiB, the SDK should throw an
 * S2Error with origin "sdk" at session creation time, matching the Rust SDK's
 * behavior (ValidationError). Previously the SDK silently clamped the value
 * to 1 MiB using Math.max(), hiding the misconfiguration.
 */

function createMockTransport(): TransportAppendSession {
	let seqNum = 0;
	return {
		submit: async (input): Promise<AppendResult> => {
			const start = seqNum;
			seqNum += input.records.length;
			return {
				ok: true,
				value: {
					start: { seqNum: start, timestamp: new Date() },
					end: { seqNum, timestamp: new Date() },
					tail: { seqNum, timestamp: new Date() },
				},
			};
		},
		close: async (): Promise<CloseResult> => ({ ok: true }),
		effectSignalled: () => false,
	};
}

describe("Issue #129: maxInflightBytes below 1 MiB should throw S2Error", () => {
	it("rejects maxInflightBytes of 0", async () => {
		await expect(
			RetryAppendSession.create(async () => createMockTransport(), {
				maxInflightBytes: 0,
			}),
		).rejects.toThrow(S2Error);
	});

	it("rejects maxInflightBytes below 1 MiB", async () => {
		await expect(
			RetryAppendSession.create(
				async () => createMockTransport(),
				{ maxInflightBytes: 512 * 1024 }, // 512 KiB
			),
		).rejects.toThrow(S2Error);
	});

	it("rejects maxInflightBytes of exactly 1 byte below 1 MiB", async () => {
		const oneMiB = 1024 * 1024;
		await expect(
			RetryAppendSession.create(async () => createMockTransport(), {
				maxInflightBytes: oneMiB - 1,
			}),
		).rejects.toThrow(S2Error);
	});

	it("error has origin 'sdk' and descriptive message", async () => {
		try {
			await RetryAppendSession.create(async () => createMockTransport(), {
				maxInflightBytes: 100,
			});
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(S2Error);
			const s2err = err as S2Error;
			expect(s2err.origin).toBe("sdk");
			expect(s2err.message).toMatch(/maxInflightBytes/i);
			expect(s2err.message).toMatch(/1 MiB/i);
		}
	});

	it("accepts maxInflightBytes of exactly 1 MiB", async () => {
		const oneMiB = 1024 * 1024;
		const session = await RetryAppendSession.create(
			async () => createMockTransport(),
			{ maxInflightBytes: oneMiB },
		);
		expect(session).toBeDefined();
		// Clean up
		await session.writable.close();
	});

	it("accepts maxInflightBytes above 1 MiB", async () => {
		const session = await RetryAppendSession.create(
			async () => createMockTransport(),
			{ maxInflightBytes: 5 * 1024 * 1024 }, // 5 MiB
		);
		expect(session).toBeDefined();
		await session.writable.close();
	});

	it("accepts undefined maxInflightBytes (uses default)", async () => {
		const session = await RetryAppendSession.create(
			async () => createMockTransport(),
			{}, // no maxInflightBytes
		);
		expect(session).toBeDefined();
		await session.writable.close();
	});

	it("rejects negative maxInflightBytes", async () => {
		await expect(
			RetryAppendSession.create(async () => createMockTransport(), {
				maxInflightBytes: -1,
			}),
		).rejects.toThrow(S2Error);
	});

	it("rejects NaN maxInflightBytes", async () => {
		await expect(
			RetryAppendSession.create(async () => createMockTransport(), {
				maxInflightBytes: Number.NaN,
			}),
		).rejects.toThrow(S2Error);
	});

	it("rejects Infinity maxInflightBytes", async () => {
		await expect(
			RetryAppendSession.create(async () => createMockTransport(), {
				maxInflightBytes: Number.POSITIVE_INFINITY,
			}),
		).rejects.toThrow(S2Error);
	});
});
