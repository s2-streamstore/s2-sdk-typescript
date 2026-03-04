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

	it("retries with appendRetryPolicy=noSideEffects when error has no side effects (rate_limited)", async () => {
		const appendMock = vi.mocked(streamAppend);
		appendMock
			.mockRejectedValueOnce(
				new S2Error({
					message: "rate limited",
					status: 429,
					code: "rate_limited",
					origin: "server",
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

	it("retries with appendRetryPolicy=noSideEffects when error has no side effects (ECONNREFUSED)", async () => {
		const appendMock = vi.mocked(streamAppend);
		appendMock
			.mockRejectedValueOnce(
				new S2Error({
					message: "Connection failed: ECONNREFUSED",
					status: 502,
					code: "ECONNREFUSED",
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

	it("retries with appendRetryPolicy=noSideEffects when error has no side effects (hot_server)", async () => {
		const appendMock = vi.mocked(streamAppend);
		appendMock
			.mockRejectedValueOnce(
				new S2Error({
					message: "hot server",
					status: 502,
					code: "hot_server",
					origin: "server",
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

	it("does not retry with appendRetryPolicy=noSideEffects when error may have side effects", async () => {
		const appendMock = vi.mocked(streamAppend);
		appendMock.mockRejectedValueOnce(
			new S2Error({ message: "transient", status: 503, origin: "server" }),
		);

		const stream = new S2Stream("test", {} as any, {} as any, {
			appendRetryPolicy: "noSideEffects",
			maxAttempts: 2,
			minBaseDelayMillis: 1,
			maxBaseDelayMillis: 1,
		});

		await expect(
			stream.append(AppendInput.create([AppendRecord.string({ body: "x" })])),
		).rejects.toBeInstanceOf(S2Error);

		expect(appendMock).toHaveBeenCalledTimes(1);
	});

	it("does not retry with appendRetryPolicy=noSideEffects even when matchSeqNum is present", async () => {
		const appendMock = vi.mocked(streamAppend);
		appendMock.mockRejectedValueOnce(
			new S2Error({ message: "unavailable", status: 503, origin: "server" }),
		);

		const stream = new S2Stream("test", {} as any, {} as any, {
			appendRetryPolicy: "noSideEffects",
			maxAttempts: 2,
			minBaseDelayMillis: 1,
			maxBaseDelayMillis: 1,
		});

		await expect(
			stream.append(
				AppendInput.create([AppendRecord.string({ body: "x" })], {
					matchSeqNum: 0,
				}),
			),
		).rejects.toBeInstanceOf(S2Error);

		expect(appendMock).toHaveBeenCalledTimes(1);
	});

	it("retries with appendRetryPolicy=all regardless of error type", async () => {
		const appendMock = vi.mocked(streamAppend);
		appendMock
			.mockRejectedValueOnce(
				new S2Error({ message: "transient", status: 503, origin: "server" }),
			)
			.mockResolvedValue({
				start: { seqNum: 0, timestamp: new Date(0) },
				end: { seqNum: 1, timestamp: new Date(0) },
				tail: { seqNum: 1, timestamp: new Date(0) },
			});

		const stream = new S2Stream("test", {} as any, {} as any, {
			appendRetryPolicy: "all",
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
