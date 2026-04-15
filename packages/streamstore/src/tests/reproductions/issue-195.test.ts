import { describe, expect, it } from "vitest";
import { S2Error } from "../../error.js";
import { AppendInput, AppendRecord } from "../../types.js";

/**
 * Issue #195: AppendRecord.fence() does not validate fencing token length,
 * but AppendInput.create() rejects tokens over 36 bytes.
 *
 * This creates an unrecoverable state: a user can set an oversized fencing
 * token via fence(), but the SDK rejects the same token when used in
 * AppendInput.create({ fencingToken }). The server's fencing_token_mismatch
 * error exposes the expected token, but the SDK then rejects it client-side.
 *
 * The fix adds the same 36-byte validation to AppendRecord.fence().
 */

describe("Issue #195: Fencing token validation in AppendRecord.fence()", () => {
	it("rejects fencing tokens over 36 bytes", () => {
		// 37 ASCII characters = 37 bytes, exceeds the 36-byte limit
		const oversizedToken = "a".repeat(37);

		expect(() => AppendRecord.fence(oversizedToken)).toThrow(S2Error);
	});

	it("rejects multi-byte fencing tokens that exceed 36 bytes", () => {
		// Each emoji is 4 bytes in UTF-8, so 10 emojis = 40 bytes > 36
		const oversizedToken = "\u{1F600}".repeat(10);

		expect(() => AppendRecord.fence(oversizedToken)).toThrow(S2Error);
	});

	it("accepts fencing tokens at exactly 36 bytes", () => {
		// 36 ASCII characters = 36 bytes, exactly at the limit
		const validToken = "a".repeat(36);

		expect(() => AppendRecord.fence(validToken)).not.toThrow();
	});

	it("accepts fencing tokens under 36 bytes", () => {
		expect(() => AppendRecord.fence("my-token")).not.toThrow();
	});

	it("fence() and AppendInput.create() should agree on token validity", () => {
		// Before the fix, fence() would accept this but AppendInput.create()
		// would reject it, creating an inconsistency.
		const oversizedToken = "a".repeat(37);

		// AppendInput.create rejects the token
		const record = AppendRecord.string({ body: "test" });
		expect(() =>
			AppendInput.create([record], { fencingToken: oversizedToken }),
		).toThrow(S2Error);

		// After fix, fence() should also reject the same token
		expect(() => AppendRecord.fence(oversizedToken)).toThrow(S2Error);
	});

	it("consistency with trim() which validates its input", () => {
		// AppendRecord.trim() validates seqNum, fence() should validate token
		expect(() => AppendRecord.trim(-1)).toThrow(S2Error);
		expect(() => AppendRecord.trim(NaN)).toThrow(S2Error);
	});
});
