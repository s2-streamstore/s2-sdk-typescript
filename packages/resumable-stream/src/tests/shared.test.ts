import {
	type AppendAck,
	type AppendInput,
	type AppendRecord as AppendRecordType,
	type ReadRecord,
	S2Error,
} from "@s2-dev/streamstore";
import { describe, expect, it } from "vitest";
import {
	claimSessionGeneration,
	claimSharedGeneration,
	replayActiveGenerationStringRecords,
	stopSharedGeneration,
	tailCompactedStringRecords,
	tailStringRecords,
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

function recordBody(record: AppendRecordType): string {
	return typeof record.body === "string"
		? record.body
		: new TextDecoder().decode(record.body);
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

	async read(input?: {
		start?: { from?: { seqNum?: number; tailOffset?: number } };
		stop?: { limits?: { count?: number } };
	}) {
		const from = input?.start?.from;
		const fromSeq =
			from?.tailOffset !== undefined
				? Math.max(0, this.records.length - from.tailOffset)
				: (from?.seqNum ?? 0);
		const count = input?.stop?.limits?.count ?? this.records.length;
		return {
			records: this.records
				.filter((record) => record.seqNum >= fromSeq)
				.slice(0, count),
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

class MissingStreamHandle extends MockStreamHandle {
	constructor() {
		super([]);
	}

	async readSession(): Promise<MockSession> {
		throw new S2Error({
			message: "stream not found",
			status: 404,
			code: "stream_not_found",
		});
	}
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
			stream: handle as any,
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
			stream: handle as any,
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
			stream: handle as any,
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
			stream: handle as any,
			fencingToken: "session-new",
			leaseDurationMs: 60_000,
			now: () => now,
		});

		expect(result).not.toBeNull();
		expect(handle.appends[0]?.fencingToken).toBe("end-AAAA");
	});
});

describe("claimSessionGeneration", () => {
	const ts = new Date(10_000_000);

	it("claims an empty session with matchSeqNum 0", async () => {
		const handle = new MockStreamHandle([]);

		const result = await claimSessionGeneration({
			stream: handle as any,
			fencingToken: "session-new",
		});

		expect(result).toMatchObject({ fromSeqNum: 0, matchSeqNumStart: 1 });
		expect(handle.appends[0]?.matchSeqNum).toBe(0);
		expect(handle.appends[0]?.fencingToken).toBe("");
	});

	it("claims from the terminal fence at the tail", async () => {
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
				body: "end-AAAA",
				headers: [["", "fence"]],
				timestamp: ts,
			}),
		]);

		const result = await claimSessionGeneration({
			stream: handle as any,
			fencingToken: "session-new",
		});

		expect(result).toMatchObject({ fromSeqNum: 3, matchSeqNumStart: 4 });
		expect(handle.appends[0]?.fencingToken).toBe("end-AAAA");
	});

	it("returns null when the session tail is still active", async () => {
		const handle = new MockStreamHandle([
			readRecord({
				seqNum: 0,
				body: "holder",
				headers: [["", "fence"]],
				timestamp: ts,
			}),
			readRecord({ seqNum: 1, body: "chunk-a", timestamp: ts }),
		]);

		const result = await claimSessionGeneration({
			stream: handle as any,
			fencingToken: "session-new",
		});

		expect(result).toBeNull();
		expect(handle.appends).toHaveLength(0);
	});
});

describe("stopSharedGeneration", () => {
	const ts = new Date(10_000_000);

	it("writes a terminal chunk and fence with the active holder token", async () => {
		const handle = new MockStreamHandle([
			readRecord({
				seqNum: 0,
				body: "holder",
				headers: [["", "fence"]],
				timestamp: ts,
			}),
			readRecord({ seqNum: 1, body: "chunk-a", timestamp: ts }),
		]);

		const stopped = await stopSharedGeneration({
			stream: handle as any,
			body: "stopped",
		});

		expect(stopped).toBe(true);
		expect(handle.appends).toHaveLength(1);
		expect(handle.appends[0]?.fencingToken).toBe("holder");
		expect(handle.appends[0]?.records.map(recordBody)).toEqual([
			"stopped",
			expect.stringMatching(/^end-/),
		]);
	});

	it("returns false when there is no active holder", async () => {
		const handle = new MockStreamHandle([
			readRecord({
				seqNum: 0,
				body: "end-AAAA",
				headers: [["", "fence"]],
				timestamp: ts,
			}),
		]);

		const stopped = await stopSharedGeneration({ stream: handle as any });

		expect(stopped).toBe(false);
		expect(handle.appends).toHaveLength(0);
	});
});

describe("replayActiveGenerationStringRecords", () => {
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

		const records = await drainAsyncIterable(
			replayActiveGenerationStringRecords(handle as any),
		);
		const bodies = records.map((record) => record.body);
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
				body: "",
				headers: [["", "trim"]],
				timestamp: ts,
			}),
			readRecord({
				seqNum: 3,
				body: "end-XYZ",
				headers: [["", "fence"]],
				timestamp: ts,
			}),
		]);

		const records = await drainAsyncIterable(
			replayActiveGenerationStringRecords(handle as any),
		);
		const bodies = records.map((record) => record.body);
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

		const records = await drainAsyncIterable(
			replayActiveGenerationStringRecords(handle as any),
		);
		const bodies = records.map((record) => record.body);
		expect(bodies).toEqual(["new-chunk-a", "new-chunk-b"]);
	});
});

describe("tailStringRecords", () => {
	const ts = new Date(10_000_000);

	it("yields data records from every generation, skipping fences and trims", async () => {
		const handle = new MockStreamHandle([
			readRecord({
				seqNum: 0,
				body: "holder-1",
				headers: [["", "fence"]],
				timestamp: ts,
			}),
			readRecord({ seqNum: 1, body: "gen-1-a", timestamp: ts }),
			readRecord({ seqNum: 2, body: "gen-1-b", timestamp: ts }),
			readRecord({
				seqNum: 3,
				body: "end-AAAA",
				headers: [["", "fence"]],
				timestamp: ts,
			}),
			readRecord({
				seqNum: 4,
				body: "holder-2",
				headers: [["", "fence"]],
				timestamp: ts,
			}),
			readRecord({ seqNum: 5, body: "gen-2-a", timestamp: ts }),
			readRecord({
				seqNum: 6,
				body: "end-BBBB",
				headers: [["", "fence"]],
				timestamp: ts,
			}),
		]);

		const records = await drainAsyncIterable(tailStringRecords(handle as any));
		const bodies = records.map((record) => record.body);
		expect(bodies).toEqual(["gen-1-a", "gen-1-b", "gen-2-a"]);
	});

	it("yields nothing on an empty stream", async () => {
		const handle = new MockStreamHandle([]);
		const records = await drainAsyncIterable(tailStringRecords(handle as any));
		const bodies = records.map((record) => record.body);
		expect(bodies).toEqual([]);
	});

	it("treats a missing stream as empty", async () => {
		const records = await drainAsyncIterable(
			tailStringRecords(new MissingStreamHandle() as any),
		);
		expect(records).toEqual([]);
	});

	it("respects fromSeqNum when provided", async () => {
		const handle = new MockStreamHandle([
			readRecord({
				seqNum: 0,
				body: "holder",
				headers: [["", "fence"]],
				timestamp: ts,
			}),
			readRecord({ seqNum: 1, body: "early", timestamp: ts }),
			readRecord({ seqNum: 2, body: "late", timestamp: ts }),
		]);

		const records = await drainAsyncIterable(
			tailStringRecords(handle as any, 2),
		);
		const bodies = records.map((record) => record.body);
		expect(bodies).toEqual(["late"]);
	});

	it("can include the next sequence cursor for reconnects", async () => {
		const handle = new MockStreamHandle([
			readRecord({
				seqNum: 0,
				body: "holder",
				headers: [["", "fence"]],
				timestamp: ts,
			}),
			readRecord({ seqNum: 1, body: "first", timestamp: ts }),
			readRecord({ seqNum: 2, body: "second", timestamp: ts }),
		]);

		const records = await drainAsyncIterable(tailStringRecords(handle as any));
		expect(records).toEqual([
			{ body: "first", nextSeqNum: 2 },
			{ body: "second", nextSeqNum: 3 },
		]);
	});
});

describe("tailCompactedStringRecords", () => {
	it("treats a missing stream as empty", async () => {
		const records = await drainAsyncIterable(
			tailCompactedStringRecords(
				new MissingStreamHandle() as any,
				(existing) => {
					expect(existing).toEqual([]);
					return [];
				},
			),
		);
		expect(records).toEqual([]);
	});
});
