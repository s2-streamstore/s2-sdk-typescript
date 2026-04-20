import type {
	AppendAck,
	AppendInput,
	ReadRecord,
	S2,
} from "@s2-dev/streamstore";
import { describe, expect, it } from "vitest";
import {
	claimSharedGeneration,
	replayActiveGenerationStringBodies,
} from "../shared.js";

function readRecord(partial: {
	seqNum: number;
	body: string;
	headers?: ReadonlyArray<readonly [string, string]>;
	timestamp: Date;
}): ReadRecord<"string"> {
	return {
		seqNum: partial.seqNum,
		body: partial.body,
		headers: partial.headers ?? [],
		timestamp: partial.timestamp,
	};
}

async function drainAsyncIterable<T>(source: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const v of source) out.push(v);
	return out;
}

interface MockSession extends AsyncIterable<ReadRecord<"string">> {
	close?(): Promise<void>;
}

class MockStreamHandle {
	readonly appends: AppendInput[] = [];

	constructor(private readonly records: ReadRecord<"string">[]) {}

	async readSession(input?: {
		start?: { from?: { seqNum?: number } };
	}): Promise<MockSession> {
		const fromSeq = input?.start?.from?.seqNum ?? 0;
		const records = this.records.filter((r) => r.seqNum >= fromSeq);
		return {
			[Symbol.asyncIterator]: async function* () {
				for (const record of records) yield record;
			},
		};
	}

	async append(input: AppendInput): Promise<AppendAck> {
		this.appends.push(input);
		const start = this.records.length;
		const end = start + input.records.length;
		return {
			start: { seqNum: start, timestamp: new Date(0) },
			end: { seqNum: end, timestamp: new Date(0) },
			tail: { seqNum: end, timestamp: new Date(0) },
		};
	}

	async close(): Promise<void> {}
}

function makeFakeS2(handle: MockStreamHandle): S2 {
	return {
		basin() {
			return {
				stream() {
					return handle;
				},
			};
		},
	} as unknown as S2;
}

describe("claimSharedGeneration lease takeover", () => {
	it("returns null when the active generation wrote a record within the lease", async () => {
		const now = 10_000_000;
		const handle = new MockStreamHandle([
			readRecord({
				seqNum: 0,
				body: "holder-1",
				headers: [["", "fence"]],
				timestamp: new Date(now - 120_000), // fence 2 min old
			}),
			readRecord({
				seqNum: 1,
				body: "data-0",
				timestamp: new Date(now - 1_000), // but last record only 1s old
			}),
		]);

		const result = await claimSharedGeneration({
			s2: makeFakeS2(handle),
			basin: "test-basin",
			stream: "test-stream",
			fencingToken: "session-new",
			leaseDurationMs: 60_000, // lease = 60s, last record 1s ago → alive
			now: () => now,
		});

		expect(result).toBeNull();
		expect(handle.appends).toHaveLength(0);
	});

	it("takes over when the last record is older than the lease", async () => {
		const now = 10_000_000;
		const handle = new MockStreamHandle([
			readRecord({
				seqNum: 0,
				body: "holder-1",
				headers: [["", "fence"]],
				timestamp: new Date(now - 300_000),
			}),
			readRecord({
				seqNum: 1,
				body: "data-0",
				timestamp: new Date(now - 120_000), // last write 2 min ago
			}),
		]);

		const result = await claimSharedGeneration({
			s2: makeFakeS2(handle),
			basin: "test-basin",
			stream: "test-stream",
			fencingToken: "session-new",
			leaseDurationMs: 60_000, // lease = 60s, last record 2 min ago → stale
			now: () => now,
		});

		expect(result).not.toBeNull();
		// First append = new fence, second = trim (since nextSeqNum > 0).
		expect(handle.appends).toHaveLength(2);
		expect(handle.appends[0]?.fencingToken).toBe("holder-1");
	});

	it("takes over a fence-only stream (no data records) once its fence is stale", async () => {
		const now = 10_000_000;
		const handle = new MockStreamHandle([
			readRecord({
				seqNum: 0,
				body: "holder-1",
				headers: [["", "fence"]],
				timestamp: new Date(now - 120_000), // fence 2 min ago, no data
			}),
		]);

		const result = await claimSharedGeneration({
			s2: makeFakeS2(handle),
			basin: "test-basin",
			stream: "test-stream",
			fencingToken: "session-new",
			leaseDurationMs: 60_000,
			now: () => now,
		});

		expect(result).not.toBeNull();
		expect(handle.appends[0]?.fencingToken).toBe("holder-1");
	});

	it("uses the terminal fence body as current token, regardless of lease", async () => {
		const now = 10_000_000;
		const handle = new MockStreamHandle([
			readRecord({
				seqNum: 0,
				body: "end-AAAA",
				headers: [["", "fence"]],
				timestamp: new Date(now - 1_000),
			}),
		]);

		const result = await claimSharedGeneration({
			s2: makeFakeS2(handle),
			basin: "test-basin",
			stream: "test-stream",
			fencingToken: "session-new",
			leaseDurationMs: 60_000,
			now: () => now,
		});

		expect(result).not.toBeNull();
		expect(handle.appends[0]?.fencingToken).toBe("end-AAAA");
	});
});

describe("replayActiveGenerationStringBodies", () => {
	const now = 10_000_000;
	const ts = new Date(now);

	it("tails data for an active (unterminated) generation", async () => {
		const handle = new MockStreamHandle([
			readRecord({
				seqNum: 0,
				body: "holder",
				headers: [["", "fence"]],
				timestamp: ts,
			}),
			readRecord({ seqNum: 1, body: "chunk-a", timestamp: ts }),
			readRecord({ seqNum: 2, body: "chunk-b", timestamp: ts }),
		]);

		const bodies = await drainAsyncIterable(
			replayActiveGenerationStringBodies({
				s2: makeFakeS2(handle),
				basin: "b",
				stream: "s",
			}),
		);
		expect(bodies).toEqual(["chunk-a", "chunk-b"]);
	});

	it("yields nothing once a terminal fence has been written (completed)", async () => {
		const handle = new MockStreamHandle([
			readRecord({
				seqNum: 0,
				body: "holder",
				headers: [["", "fence"]],
				timestamp: ts,
			}),
			readRecord({ seqNum: 1, body: "chunk-a", timestamp: ts }),
			readRecord({
				seqNum: 2,
				body: "end-XYZ",
				headers: [["", "fence"]],
				timestamp: ts,
			}),
			// Single-use cleanup trim after the terminal fence.
			readRecord({
				seqNum: 3,
				body: "",
				headers: [["", "trim"]],
				timestamp: ts,
			}),
		]);

		const bodies = await drainAsyncIterable(
			replayActiveGenerationStringBodies({
				s2: makeFakeS2(handle),
				basin: "b",
				stream: "s",
			}),
		);
		expect(bodies).toEqual([]);
	});

	it("shared: replay skips opening fence + claim-trim and yields only the new gen's data", async () => {
		const handle = new MockStreamHandle([
			// Prior generation (completed)
			readRecord({
				seqNum: 0,
				body: "holder-old",
				headers: [["", "fence"]],
				timestamp: ts,
			}),
			readRecord({ seqNum: 1, body: "old-chunk", timestamp: ts }),
			readRecord({
				seqNum: 2,
				body: "end-XYZ",
				headers: [["", "fence"]],
				timestamp: ts,
			}),
			// New claim
			readRecord({
				seqNum: 3,
				body: "holder-new",
				headers: [["", "fence"]],
				timestamp: ts,
			}),
			readRecord({
				seqNum: 4,
				body: "",
				headers: [["", "trim"]],
				timestamp: ts,
			}),
			readRecord({ seqNum: 5, body: "new-chunk-a", timestamp: ts }),
			readRecord({ seqNum: 6, body: "new-chunk-b", timestamp: ts }),
		]);

		const bodies = await drainAsyncIterable(
			replayActiveGenerationStringBodies({
				s2: makeFakeS2(handle),
				basin: "b",
				stream: "s",
			}),
		);
		expect(bodies).toEqual(["new-chunk-a", "new-chunk-b"]);
	});
});
