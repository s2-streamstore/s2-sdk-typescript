import { beforeEach, describe, expect, it, vi } from "vitest";
import { S2Error } from "../../error.js";
import { AppendInput, AppendRecord } from "../../types.js";

vi.mock("../../lib/stream/transport/fetch/shared.js", () => ({
	streamAppend: vi.fn(),
	streamRead: vi.fn(),
}));

import { streamAppend } from "../../lib/stream/transport/fetch/shared.js";
import { S2Stream } from "../../stream.js";

/**
 * Issue #327: `UND_ERR_CONNECT_TIMEOUT` (undici connect timeout) is a
 * pre-connection failure — the TCP handshake never completed, so no request
 * bytes could have been written and no mutation occurred. It must therefore
 * be classified as having no side effects, exactly like `ECONNREFUSED`, so
 * that appends retry under `appendRetryPolicy: "noSideEffects"`.
 *
 * Regression from #322: `UND_ERR_CONNECT_TIMEOUT` was added to
 * `isConnectionError()` but omitted from `hasNoSideEffects()`, causing appends
 * to abort instead of retry.
 */
describe("Issue #327: UND_ERR_CONNECT_TIMEOUT is retryable under noSideEffects", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("classifies UND_ERR_CONNECT_TIMEOUT from sdk as having no side effects", () => {
		const error = new S2Error({
			message: "connect timeout",
			status: 502,
			code: "UND_ERR_CONNECT_TIMEOUT",
			origin: "sdk",
		});
		expect(error.hasNoSideEffects()).toBe(true);
	});

	it("retries the append under appendRetryPolicy=noSideEffects", async () => {
		const appendMock = vi.mocked(streamAppend);
		appendMock
			.mockRejectedValueOnce(
				new S2Error({
					message: "connect timeout",
					status: 502,
					code: "UND_ERR_CONNECT_TIMEOUT",
					origin: "sdk",
				}),
			)
			.mockResolvedValue({
				start: { seqNum: 0, timestamp: new Date(0) },
				end: { seqNum: 1, timestamp: new Date(0) },
				tail: { seqNum: 1, timestamp: new Date(0) },
			});

		const stream = new S2Stream("test", {} as any, {} as any, {
			appendRetryPolicy: "noSideEffects",
			maxAttempts: 2,
			minBaseDelayMillis: 1,
			maxBaseDelayMillis: 1,
		});

		const ack = await stream.append(
			AppendInput.create([AppendRecord.string({ body: "x" })]),
		);

		expect(ack.start.seqNum).toBe(0);
		expect(appendMock).toHaveBeenCalledTimes(2);
	});
});
