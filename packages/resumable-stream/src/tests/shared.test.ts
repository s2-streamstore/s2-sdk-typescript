import type {
	AppendAck,
	AppendInput,
	ReadRecord,
	S2,
} from "@s2-dev/streamstore";
import { describe, expect, it } from "vitest";
import { claimSharedGeneration } from "../shared.js";

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

interface MockSession extends AsyncIterable<ReadRecord<"string">> {
	close?(): Promise<void>;
}

class MockStreamHandle {
	readonly appends: AppendInput[] = [];
	private sessionCreated = 0;

	constructor(private readonly records: ReadRecord<"string">[]) {}

	async readSession(): Promise<MockSession> {
		this.sessionCreated += 1;
		const records = this.records;
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

describe("claimSharedGeneration — lease takeover", () => {
	it("returns null when a non-terminal fence is still within its lease", async () => {
		const now = 10_000_000;
		const handle = new MockStreamHandle([
			readRecord({
				seqNum: 0,
				body: "holder-1",
				headers: [["", "fence"]],
				timestamp: new Date(now - 1_000), // 1s ago
			}),
		]);

		const result = await claimSharedGeneration({
			s2: makeFakeS2(handle),
			basin: "test-basin",
			stream: "test-stream",
			fencingToken: "session-new",
			leaseDurationMs: 60_000, // 60s lease, 1s elapsed → still held
			now: () => now,
		});

		expect(result).toBeNull();
		expect(handle.appends).toHaveLength(0);
	});

	it("takes over a stale non-terminal fence once the lease expires", async () => {
		const now = 10_000_000;
		const handle = new MockStreamHandle([
			readRecord({
				seqNum: 0,
				body: "holder-1",
				headers: [["", "fence"]],
				timestamp: new Date(now - 120_000), // 120s ago
			}),
		]);

		const result = await claimSharedGeneration({
			s2: makeFakeS2(handle),
			basin: "test-basin",
			stream: "test-stream",
			fencingToken: "session-new",
			leaseDurationMs: 60_000, // 60s lease, 120s elapsed → stale
			now: () => now,
		});

		expect(result).not.toBeNull();
		// First append = new fence, second = trim (since nextSeqNum > 0).
		expect(handle.appends).toHaveLength(2);
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
