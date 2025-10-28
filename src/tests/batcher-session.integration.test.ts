import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendAck } from "../generated/index.js";
import * as Redacted from "../lib/redacted.js";
import { S2Stream } from "../stream.js";

const fakeClient: any = {};
const fakeTransportConfig = {
	baseUrl: "https://test.s2.dev/v1",
	accessToken: Redacted.make("test-token"),
};
const makeStream = () =>
	new S2Stream("test-stream", fakeClient, fakeTransportConfig);
const makeAck = (n: number): AppendAck => ({
	start: { seq_num: n - 1, timestamp: 0 },
	end: { seq_num: n, timestamp: 0 },
	tail: { seq_num: n, timestamp: 0 },
});

describe("Batcher + AppendSession integration", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("linger-driven batching yields single session submission", async () => {
		const stream = makeStream();
		const session = await stream.appendSession();
		const appendSpy = vi.spyOn(stream, "append").mockResolvedValue(makeAck(1));
		const batcher = session.makeBatcher({
			lingerDuration: 10,
			maxBatchSize: 100,
		});

		const p1 = batcher.submit({ body: "a" });
		const p2 = batcher.submit({ body: "b" });

		await vi.advanceTimersByTimeAsync(12);
		await Promise.all([p1, p2]);

		expect(appendSpy).toHaveBeenCalledTimes(1);
		expect(appendSpy.mock.calls?.[0]?.[0]).toHaveLength(2);
	});

	it("batch overflow increments match_seq_num across multiple flushes", async () => {
		const stream = makeStream();
		const session = await stream.appendSession();
		const appendSpy = vi.spyOn(stream, "append");
		appendSpy.mockResolvedValueOnce(makeAck(1));
		appendSpy.mockResolvedValueOnce(makeAck(2));
		const batcher = session.makeBatcher({
			lingerDuration: 0,
			maxBatchSize: 2,
			match_seq_num: 5,
		});

		const p1 = batcher.submit([{ body: "1" }, { body: "2" }]);
		batcher.flush();
		await p1;
		const p2 = batcher.submit([{ body: "3" }]);
		batcher.flush();
		await p2;

		expect(appendSpy).toHaveBeenCalledTimes(2);
		expect(appendSpy.mock.calls?.[0]?.[1]).toMatchObject({ match_seq_num: 5 });
		expect(appendSpy.mock.calls?.[1]?.[1]).toMatchObject({ match_seq_num: 7 });
	});

	it("batcher promise resolves with ack from session/stream", async () => {
		const stream = makeStream();
		const session = await stream.appendSession();
		vi.spyOn(stream, "append").mockResolvedValue(makeAck(123));
		const batcher = session.makeBatcher({
			lingerDuration: 0,
			maxBatchSize: 10,
		});

		const ackPromise = batcher.submit({ body: "x" });
		batcher.flush();
		const ack = await ackPromise;
		expect(ack.end.seq_num).toBe(123);
	});
});
