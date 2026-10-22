import type {
	AppendAck,
	AppendInput,
	AppendRecord as AppendRecordType,
	S2,
} from "@s2-dev/streamstore";
import { AppendRecord, MAX_APPEND_BYTES } from "@s2-dev/streamstore";
import { describe, expect, it } from "vitest";
import { createPartAssembler, dataRecords, persistToS2 } from "../protocol.js";

interface SubmitTicket {
	ack(): Promise<AppendAck>;
	bytes: number;
	numRecords: number;
}

function makeAck(startSeqNum: number, endSeqNum: number): AppendAck {
	return {
		start: { seqNum: startSeqNum, timestamp: new Date(0) },
		end: { seqNum: endSeqNum, timestamp: new Date(0) },
		tail: { seqNum: endSeqNum, timestamp: new Date(0) },
	};
}

class RecordingAppendSession {
	readonly readable = new ReadableStream<AppendAck>();
	readonly writable = new WritableStream<AppendInput>();
	private readonly ackStream = new ReadableStream<AppendAck>();
	private seqNum = 0;
	private submitCount = 0;
	readonly records: AppendRecordType[] = [];
	closeCount = 0;

	constructor(private readonly failOnSubmit?: number) {}

	async submit(input: AppendInput): Promise<SubmitTicket> {
		this.submitCount += 1;
		if (this.submitCount === this.failOnSubmit) {
			throw new Error(`submit #${this.submitCount} failed`);
		}

		this.records.push(...input.records);
		const ack = makeAck(this.seqNum, this.seqNum + input.records.length);
		this.seqNum = ack.end.seqNum;

		return {
			ack: async () => ack,
			bytes: 0,
			numRecords: input.records.length,
		};
	}

	async close(): Promise<void> {
		this.closeCount += 1;
	}

	acks() {
		return this.ackStream as typeof this.ackStream & AsyncIterable<AppendAck>;
	}

	lastAckedPosition(): AppendAck | undefined {
		return undefined;
	}

	failureCause(): undefined {
		return undefined;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}
}

class RecordingStreamHandle {
	readonly session: RecordingAppendSession;
	readonly directAppends: AppendInput[] = [];
	closeCount = 0;

	constructor(failOnSubmit?: number) {
		this.session = new RecordingAppendSession(failOnSubmit);
	}

	async appendSession() {
		return this.session as unknown as {
			submit(input: AppendInput): Promise<SubmitTicket>;
			close(): Promise<void>;
		};
	}

	async append(input: AppendInput): Promise<AppendAck> {
		this.directAppends.push(input);
		return makeAck(0, input.records.length);
	}

	async close(): Promise<void> {
		this.closeCount += 1;
	}
}

function makeFakeS2(handle: RecordingStreamHandle): S2 {
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

async function* fromValues(values: string[]): AsyncIterable<string> {
	for (const value of values) {
		yield value;
	}
}

async function* fromValuesThenThrow(
	values: string[],
	error: Error,
): AsyncIterable<string> {
	yield* fromValues(values);
	throw error;
}

function toText(value: string | Uint8Array): string {
	return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function summarizeRecords(
	records: ReadonlyArray<AppendRecordType>,
): Array<{ body: string; headers: string[][] }> {
	return records.map((record) => ({
		body: toText(record.body),
		headers: (record.headers ?? []).map(([key, value]) => [
			toText(key),
			toText(value),
		]),
	}));
}

describe("persistToS2", () => {
	it("submits successful final fences through the producer", async () => {
		const handle = new RecordingStreamHandle();

		await persistToS2({
			s2: makeFakeS2(handle),
			basin: "test-basin",
			stream: "test-stream",
			source: fromValues(["alpha", "beta"]),
			fencingToken: "session-1",
			batchSize: 1,
			lingerDuration: 0,
			toRecords: (value) => [AppendRecord.string({ body: value })],
			finalRecords: () => [AppendRecord.fence("end-token")],
		});

		expect(summarizeRecords(handle.session.records)).toEqual([
			{ body: "alpha", headers: [] },
			{ body: "beta", headers: [] },
			{ body: "end-token", headers: [["", "fence"]] },
		]);
		expect(handle.directAppends).toHaveLength(0);
		expect(handle.session.closeCount).toBe(1);
		expect(handle.closeCount).toBe(1);
	});

	it("submits failure records through the producer before rejecting", async () => {
		const handle = new RecordingStreamHandle();
		const sourceError = new Error("source failed");

		await expect(
			persistToS2({
				s2: makeFakeS2(handle),
				basin: "test-basin",
				stream: "test-stream",
				source: fromValuesThenThrow(["alpha"], sourceError),
				fencingToken: "session-1",
				batchSize: 1,
				lingerDuration: 0,
				toRecords: (value) => [AppendRecord.string({ body: value })],
				finalRecords: (failed) =>
					failed
						? [
								AppendRecord.string({ body: "stream-error" }),
								AppendRecord.fence("error-token"),
							]
						: [AppendRecord.fence("end-token")],
			}),
		).rejects.toThrow("source failed");

		expect(summarizeRecords(handle.session.records)).toEqual([
			{ body: "alpha", headers: [] },
			{ body: "stream-error", headers: [] },
			{ body: "error-token", headers: [["", "fence"]] },
		]);
		expect(handle.directAppends).toHaveLength(0);
	});

	it("appends final records directly and throws when final producer submission fails", async () => {
		const handle = new RecordingStreamHandle(2);

		await expect(
			persistToS2({
				s2: makeFakeS2(handle),
				basin: "test-basin",
				stream: "test-stream",
				source: fromValues(["alpha"]),
				fencingToken: "session-1",
				batchSize: 1,
				lingerDuration: 0,
				toRecords: (value) => [AppendRecord.string({ body: value })],
				finalRecords: () => [AppendRecord.fence("end-token")],
			}),
		).rejects.toThrow("submit #2 failed");

		expect(summarizeRecords(handle.session.records)).toEqual([
			{ body: "alpha", headers: [] },
		]);
		expect(handle.directAppends).toHaveLength(1);
		expect(handle.directAppends[0]?.fencingToken).toBe("session-1");
		expect(summarizeRecords(handle.directAppends[0]!.records)).toEqual([
			{ body: "end-token", headers: [["", "fence"]] },
		]);
	});

	it("passes producer submit failures to finalRecords", async () => {
		const handle = new RecordingStreamHandle();
		let finalRecordsError: unknown;

		await expect(
			persistToS2({
				s2: makeFakeS2(handle),
				basin: "test-basin",
				stream: "test-stream",
				source: fromValues(["x".repeat(1024 * 1024 + 1)]),
				fencingToken: "session-1",
				batchSize: 1,
				lingerDuration: 0,
				toRecords: (value) => [AppendRecord.string({ body: value })],
				finalRecords: (sourceError) => {
					finalRecordsError = sourceError;
					return [AppendRecord.fence("end-token")];
				},
			}),
		).rejects.toThrow();

		expect(finalRecordsError).toBeInstanceOf(Error);
	});
});

describe("dataRecords", () => {
	it("splits oversized bodies into parts that reassemble exactly", () => {
		const body = `${"a".repeat(1_500_000)}é😀${"b".repeat(700_000)}`;
		const records = dataRecords(body);

		expect(records.length).toBeGreaterThan(2);
		for (const record of records) {
			expect(record.meteredBytes).toBeLessThanOrEqual(MAX_APPEND_BYTES);
		}

		const assemble = createPartAssembler();
		const bodies = records
			.map((record) =>
				assemble(record as { headers: [string, string][]; body: string }),
			)
			.filter((value) => value !== undefined);
		expect(bodies).toEqual([body]);
	});

	it("drops parts whose first part was not read", () => {
		const [, ...rest] = dataRecords("x".repeat(2_500_000));
		const assemble = createPartAssembler();
		const bodies = rest
			.map((record) =>
				assemble(record as { headers: [string, string][]; body: string }),
			)
			.filter((value) => value !== undefined);
		expect(bodies).toEqual([]);
	});
});
