import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/stream/transport/fetch/shared.js", () => ({
	streamAppend: vi.fn(),
	streamRead: vi.fn(),
}));

import * as SharedTransport from "../../lib/stream/transport/fetch/shared.js";
import { S2Stream } from "../../stream.js";

/**
 * Issue #164 / #231: `S2Stream.read()` with `ignoreCommandRecords`.
 *
 * A unary `read()` performs exactly ONE request and filters command records out
 * of that single batch. The result may be empty when every record in the batch 
 * was a command record; this is intended behavior. Consumers that need to transparently 
 * keep reading until data records are found should use `readSession()`.
 *
 * #231 was caused by an earlier loop that re-issued a full read (with the
 * original `count`/`bytes`) for every command-only batch, amplifying a single
 * `count: 1` request into many. There is no loop, so there is no amplification.
 */

describe("Issue #164/#231: S2Stream.read() with ignoreCommandRecords", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("filters command records from the single batch and passes the flag through", async () => {
		const streamReadMock = vi.mocked(SharedTransport.streamRead);
		streamReadMock.mockResolvedValueOnce({
			records: [
				{
					seq_num: 0,
					timestamp: 0,
					body: "fence-token",
					headers: [["", "fence"]],
				},
				{
					seq_num: 1,
					timestamp: 1,
					body: "real-data",
					headers: [["key", "value"]],
				},
			],
			tail: { seq_num: 2, timestamp: 2 },
		} as any);

		const stream = new S2Stream("test-stream", {} as any, {} as any);

		const result = await stream.read({
			start: { from: { seqNum: 0 } },
			ignoreCommandRecords: true,
		});

		expect(streamReadMock).toHaveBeenCalledTimes(1);
		expect(streamReadMock.mock.calls[0]?.[2]).toMatchObject({
			seq_num: 0,
			ignore_command_records: true,
		});
		expect(result.records).toHaveLength(1);
		expect(result.records[0]!.body).toBe("real-data");
	});

	it("returns an empty batch (no extra requests) when all records are command records", async () => {
		const streamReadMock = vi.mocked(SharedTransport.streamRead);
		streamReadMock.mockResolvedValueOnce({
			records: [
				{
					seq_num: 0,
					timestamp: 0,
					body: "fence-token",
					headers: [["", "fence"]],
				},
				{
					seq_num: 1,
					timestamp: 1,
					body: "trim-token",
					headers: [["", "trim"]],
				},
			],
			tail: { seq_num: 2, timestamp: 2 },
		} as any);

		const stream = new S2Stream("test-stream", {} as any, {} as any);

		const result = await stream.read({
			start: { from: { seqNum: 0 } },
			ignoreCommandRecords: true,
		});

		// #231: exactly one request, regardless of the count budget.
		expect(streamReadMock).toHaveBeenCalledTimes(1);
		expect(result.records).toEqual([]);
	});

	it("does not amplify requests when count is set and the batch is command-only", async () => {
		const streamReadMock = vi.mocked(SharedTransport.streamRead);
		streamReadMock.mockResolvedValueOnce({
			records: [
				{
					seq_num: 0,
					timestamp: 0,
					body: "cmd",
					headers: [["", "fence"]],
				},
			],
			tail: { seq_num: 1, timestamp: 1 },
		} as any);

		const stream = new S2Stream("test-stream", {} as any, {} as any);

		const result = await stream.read({
			start: { from: { seqNum: 0 } },
			stop: { limits: { count: 1 } },
			ignoreCommandRecords: true,
		});

		expect(streamReadMock).toHaveBeenCalledTimes(1);
		expect(result.records).toEqual([]);
	});

	it("does not filter when ignoreCommandRecords is false", async () => {
		const streamReadMock = vi.mocked(SharedTransport.streamRead);
		streamReadMock.mockResolvedValueOnce({
			records: [
				{
					seq_num: 0,
					timestamp: 0,
					body: "cmd",
					headers: [["", "fence"]],
				},
			],
			tail: { seq_num: 1, timestamp: 1 },
		} as any);

		const stream = new S2Stream("test-stream", {} as any, {} as any);

		const result = await stream.read({
			start: { from: { seqNum: 0 } },
			ignoreCommandRecords: false,
		});

		expect(streamReadMock).toHaveBeenCalledTimes(1);
		expect(streamReadMock.mock.calls[0]?.[2]).toMatchObject({
			seq_num: 0,
			ignore_command_records: false,
		});
		expect(result.records).toHaveLength(1);
		expect(result.records[0]!.body).toBe("cmd");
	});
});
