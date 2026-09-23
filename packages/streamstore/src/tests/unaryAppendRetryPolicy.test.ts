import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	AppendIndefiniteFailureError,
	S2Error,
	withPriorUncertainty,
} from "../error.js";
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

function serverError(status: number, code: string): S2Error {
	return new S2Error({ message: code, status, code, origin: "server" });
}

/** A non-retryable error that the SDK regards as definite. */
class DefiniteTerminalError extends S2Error {
	constructor() {
		super({
			message: "permission_denied",
			status: 403,
			code: "permission_denied",
			origin: "server",
		});
	}

	override hasNoSideEffects(): boolean {
		return true;
	}
}

describe("withPriorUncertainty", () => {
	it("leaves a definite error unchanged without prior uncertainty", () => {
		const error = serverError(429, "rate_limited");
		expect(withPriorUncertainty(error, false)).toBe(error);
	});

	it("leaves an already indefinite error unchanged", () => {
		const error = serverError(503, "unavailable");
		expect(withPriorUncertainty(error, true)).toBe(error);
	});

	it("wraps a definite error and does not double wrap", () => {
		const final = serverError(429, "rate_limited");
		const wrapped = withPriorUncertainty(final, true);
		expect(wrapped).toBeInstanceOf(AppendIndefiniteFailureError);
		expect(wrapped.hasNoSideEffects()).toBe(false);
		expect(wrapped.status).toBe(429);
		expect(wrapped.code).toBe("rate_limited");
		expect(wrapped.cause).toBe(final);
		expect((wrapped as AppendIndefiniteFailureError).finalAttemptError).toBe(
			final,
		);
		expect(withPriorUncertainty(wrapped, true)).toBe(wrapped);
	});
});

describe("Unary append uncertainty across retries", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	const ack = {
		start: { seqNum: 0, timestamp: new Date(0) },
		end: { seqNum: 1, timestamp: new Date(0) },
		tail: { seqNum: 1, timestamp: new Date(0) },
	};

	function makeStream(maxAttempts: number) {
		return new S2Stream("test", {} as any, {} as any, {
			appendRetryPolicy: "all",
			maxAttempts,
			minBaseDelayMillis: 1,
			maxBaseDelayMillis: 1,
		});
	}

	it("indefinite then definite: whole append reported indefinite, final error retained", async () => {
		vi.mocked(streamAppend)
			.mockRejectedValueOnce(serverError(503, "unavailable"))
			.mockRejectedValueOnce(serverError(429, "rate_limited"));

		const error = await makeStream(2)
			.append(AppendInput.create([AppendRecord.string({ body: "x" })]))
			.catch((e) => e);

		expect(error).toBeInstanceOf(AppendIndefiniteFailureError);
		expect(error.hasNoSideEffects()).toBe(false);
		expect(error.finalAttemptError.code).toBe("rate_limited");
		expect(error.status).toBe(429);
	});

	it("indefinite then non-retryable definite: wraps and stops retrying", async () => {
		vi.mocked(streamAppend)
			.mockRejectedValueOnce(serverError(503, "unavailable"))
			.mockRejectedValueOnce(new DefiniteTerminalError());

		const error = await makeStream(3)
			.append(AppendInput.create([AppendRecord.string({ body: "x" })]))
			.catch((e) => e);

		expect(error).toBeInstanceOf(AppendIndefiniteFailureError);
		expect(error.finalAttemptError.status).toBe(403);
		expect(vi.mocked(streamAppend)).toHaveBeenCalledTimes(2);
	});

	it("definite then definite: final error returned unwrapped", async () => {
		vi.mocked(streamAppend)
			.mockRejectedValueOnce(serverError(429, "rate_limited"))
			.mockRejectedValueOnce(serverError(429, "rate_limited"));

		const error = await makeStream(2)
			.append(AppendInput.create([AppendRecord.string({ body: "x" })]))
			.catch((e) => e);

		expect(error).not.toBeInstanceOf(AppendIndefiniteFailureError);
		expect(error.hasNoSideEffects()).toBe(true);
	});

	it("indefinite then indefinite: final error returned unwrapped", async () => {
		vi.mocked(streamAppend)
			.mockRejectedValueOnce(serverError(503, "unavailable"))
			.mockRejectedValueOnce(serverError(503, "unavailable"));

		const error = await makeStream(2)
			.append(AppendInput.create([AppendRecord.string({ body: "x" })]))
			.catch((e) => e);

		expect(error).not.toBeInstanceOf(AppendIndefiniteFailureError);
		expect(error.hasNoSideEffects()).toBe(false);
	});

	it("success after indefinite failure returns the ack", async () => {
		vi.mocked(streamAppend)
			.mockRejectedValueOnce(serverError(503, "unavailable"))
			.mockResolvedValue(ack);

		const result = await makeStream(2).append(
			AppendInput.create([AppendRecord.string({ body: "x" })]),
		);
		expect(result.start.seqNum).toBe(0);
	});
});
