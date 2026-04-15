import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/stream/transport/fetch/shared.js", () => ({
	streamAppend: vi.fn(),
	streamRead: vi.fn(),
}));

import * as SharedTransport from "../../lib/stream/transport/fetch/shared.js";
import { S2Stream } from "../../stream.js";

/**
 * Issue #164: Unary read with ignoreCommandRecords can return empty batches
 * and stop consumers prematurely.
 *
 * The regression lives in `S2Stream.read()`, not in the case-transform or
 * mapper helpers. These tests hit the real method and assert on the actual
 * `streamRead()` calls it makes.
 */

describe("Issue #164: S2Stream.read() with ignoreCommandRecords", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("passes ignore_command_records through and skips command-only batches", async () => {
		const streamReadMock = vi.mocked(SharedTransport.streamRead);
		streamReadMock
			.mockResolvedValueOnce({
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
			} as any)
			.mockResolvedValueOnce({
				records: [
					{
						seq_num: 2,
						timestamp: 2,
						body: "real-data",
						headers: [["key", "value"]],
					},
				],
				tail: { seq_num: 3, timestamp: 3 },
			} as any);

		const stream = new S2Stream("test-stream", {} as any, {} as any);

		const result = await stream.read({
			start: { from: { seqNum: 0 } },
			ignoreCommandRecords: true,
		});

		expect(streamReadMock).toHaveBeenCalledTimes(2);
		expect(streamReadMock.mock.calls[0]?.[2]).toMatchObject({
			seq_num: 0,
			ignore_command_records: true,
		});
		expect(streamReadMock.mock.calls[1]?.[2]).toMatchObject({
			seq_num: 2,
			ignore_command_records: true,
		});
		expect(result.records).toHaveLength(1);
		expect(result.records[0]!.body).toBe("real-data");
	});

	it("returns an empty batch only after the stream is actually exhausted", async () => {
		const streamReadMock = vi.mocked(SharedTransport.streamRead);
		streamReadMock
			.mockResolvedValueOnce({
				records: [
					{
						seq_num: 0,
						timestamp: 0,
						body: "cmd",
						headers: [["", "fence"]],
					},
				],
				tail: { seq_num: 1, timestamp: 1 },
			} as any)
			.mockResolvedValueOnce({
				records: [],
				tail: { seq_num: 1, timestamp: 1 },
			} as any);

		const stream = new S2Stream("test-stream", {} as any, {} as any);

		const result = await stream.read({
			start: { from: { seqNum: 0 } },
			ignoreCommandRecords: true,
		});

		expect(streamReadMock).toHaveBeenCalledTimes(2);
		expect(result.records).toEqual([]);
	});

	it("does not loop or filter when ignoreCommandRecords is false", async () => {
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
