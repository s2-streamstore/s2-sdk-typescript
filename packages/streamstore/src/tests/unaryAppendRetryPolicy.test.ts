import { beforeEach, describe, expect, it, vi } from "vitest";
import { S2Error } from "../error.js";
import { AppendInput, AppendRecord } from "../types.js";

vi.mock("../lib/stream/transport/fetch/shared.js", () => ({
	streamAppend: vi.fn(),
	streamRead: vi.fn(),
}));

import { streamAppend } from "../lib/stream/transport/fetch/shared.js";
import { S2Stream } from "../stream.js";

describe("Unary append retry policy", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("retries with appendRetryPolicy=noSideEffects when matchSeqNum=0", async () => {
		const appendMock = vi.mocked(streamAppend);
		appendMock
			.mockRejectedValueOnce(new S2Error({ message: "transient", status: 503 }))
			.mockResolvedValue({
				start: { seqNum: 0, timestamp: new Date(0) },
				end: { seqNum: 1, timestamp: new Date(0) },
				tail: { seqNum: 1, timestamp: new Date(0) },
			});

		const stream = new S2Stream("test", {} as any, {} as any, {
			appendRetryPolicy: "noSideEffects",
			maxAttempts: 2,
			minDelayMillis: 1,
			maxDelayMillis: 1,
		});

		const ack = await stream.append(
			AppendInput.create([AppendRecord.string({ body: "x" })], {
				matchSeqNum: 0,
			}),
		);

		expect(ack.start.seqNum).toBe(0);
		expect(appendMock).toHaveBeenCalledTimes(2);
	});

	it("does not retry with appendRetryPolicy=noSideEffects when matchSeqNum is undefined", async () => {
		const appendMock = vi.mocked(streamAppend);
		appendMock.mockRejectedValueOnce(
			new S2Error({ message: "transient", status: 503 }),
		);

		const stream = new S2Stream("test", {} as any, {} as any, {
			appendRetryPolicy: "noSideEffects",
			maxAttempts: 2,
			minDelayMillis: 1,
			maxDelayMillis: 1,
		});

		await expect(
			stream.append(AppendInput.create([AppendRecord.string({ body: "x" })])),
		).rejects.toBeInstanceOf(S2Error);

		expect(appendMock).toHaveBeenCalledTimes(1);
	});
});
