import type {
	AppendAck,
	AppendInput,
	AppendRecord as AppendRecordType,
	ReadRecord,
} from "@s2-dev/streamstore";
import { describe, expect, it, vi } from "vitest";

interface SubmitTicket {
	ack(): Promise<AppendAck>;
	bytes: number;
	numRecords: number;
}

function makeAck(start: number, end: number): AppendAck {
	return {
		start: { seqNum: start, timestamp: new Date(0) },
		end: { seqNum: end, timestamp: new Date(0) },
		tail: { seqNum: end, timestamp: new Date(0) },
	};
}

class FakeAppendSession {
	readonly records: AppendRecordType[] = [];
	closeCount = 0;
	private seqNum = 0;

	async submit(input: AppendInput): Promise<SubmitTicket> {
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
}

interface FakeStreamOptions {
	failFenceClaim?: boolean;
	readRecords?: ReadRecord<"string">[];
}

class FakeStream {
	readonly session = new FakeAppendSession();
	readonly directAppends: AppendInput[] = [];
	closeCount = 0;
	private nextSeqOnAppend: number;

	constructor(private readonly options: FakeStreamOptions = {}) {
		this.nextSeqOnAppend = options.readRecords?.length ?? 0;
	}

	async appendSession() {
		return this.session;
	}

	async append(input: AppendInput): Promise<AppendAck> {
		if (this.options.failFenceClaim) {
			const { SeqNumMismatchError } = await import("@s2-dev/streamstore");
			throw new SeqNumMismatchError({
				message: "stream already in use",
				status: 412,
				expectedSeqNum: 1,
			});
		}
		this.directAppends.push(input);
		const start = this.nextSeqOnAppend;
		this.nextSeqOnAppend += input.records.length;
		return makeAck(start, this.nextSeqOnAppend);
	}

	async readSession() {
		const records = this.options.readRecords ?? [];
		return {
			[Symbol.asyncIterator]: async function* () {
				for (const record of records) yield record;
			},
		};
	}

	async close(): Promise<void> {
		this.closeCount += 1;
	}
}

const { activeStreamRef } = vi.hoisted(() => ({
	activeStreamRef: { current: null as FakeStream | null },
}));

vi.mock("@s2-dev/streamstore", async () => {
	const actual = await vi.importActual<typeof import("@s2-dev/streamstore")>(
		"@s2-dev/streamstore",
	);
	class MockS2 {
		basin() {
			return {
				stream: () => activeStreamRef.current,
			};
		}
	}
	return { ...actual, S2: MockS2 };
});

async function readSseFrames(response: Response): Promise<string[]> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const frames: string[] = [];
	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		const parts = buffer.split(/\r?\n\r?\n/);
		buffer = parts.pop() ?? "";
		for (const part of parts) {
			const data = part
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (data) frames.push(data);
		}
		if (done) break;
	}
	return frames;
}

async function* okSource(): AsyncIterable<{
	type: string;
	timestamp?: number;
	[key: string]: unknown;
}> {
	yield { type: "RUN_STARTED", timestamp: 1 };
	yield {
		type: "TEXT_MESSAGE_CONTENT",
		timestamp: 2,
		messageId: "m1",
		delta: "hello",
	};
	yield { type: "RUN_FINISHED", timestamp: 3 };
}

async function* failingSource(): AsyncIterable<{
	type: string;
	timestamp?: number;
	[key: string]: unknown;
}> {
	yield { type: "RUN_STARTED", timestamp: 1 };
	yield {
		type: "TEXT_MESSAGE_CONTENT",
		timestamp: 2,
		messageId: "m1",
		delta: "partial",
	};
	throw new Error("model exploded");
}

describe("createResumableChat (tanstack-ai)", () => {
	it("exposes the documented helper shape", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		const chat = createResumableChat({
			accessToken: "test-token",
			basin: "test-basin",
		});
		expect(typeof chat.makeResumable).toBe("function");
		expect(typeof chat.replay).toBe("function");
	});

	it("returns 409 when the single-use fence claim is rejected", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		activeStreamRef.current = new FakeStream({ failFenceClaim: true });

		const chat = createResumableChat({ accessToken: "t", basin: "b" });
		const response = await chat.makeResumable("s", okSource());
		expect(response.status).toBe(409);
	});

	it("emits RUN_ERROR on the live SSE when the source throws", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		activeStreamRef.current = new FakeStream();

		const chat = createResumableChat({
			accessToken: "t",
			basin: "b",
			batchSize: 1,
			lingerDuration: 0,
			onError: () => "model exploded",
		});

		const persisted: Promise<unknown>[] = [];
		const response = await chat.makeResumable("s", failingSource(), {
			waitUntil: (p) => {
				persisted.push(p.catch(() => {}));
			},
		});
		expect(response.status).toBe(200);

		const frames = await readSseFrames(response);
		expect(frames.at(-1)).toBe("[DONE]");

		const errorFrame = frames.find((f) => f.includes('"type":"RUN_ERROR"'));
		expect(errorFrame).toBeDefined();
		expect(JSON.parse(errorFrame!)).toMatchObject({
			type: "RUN_ERROR",
			error: { message: "model exploded" },
		});

		await Promise.allSettled(persisted);
	});

	it("returns 204 from replay when there is no active generation", async () => {
		const { createResumableChat } = await import("../tanstack-ai.js");
		activeStreamRef.current = new FakeStream();

		const chat = createResumableChat({ accessToken: "t", basin: "b" });
		const response = await chat.replay("s");
		expect(response.status).toBe(204);
	});
});
