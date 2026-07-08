import { describe, expect, it } from "vitest";
import { type ChatAdapter, createChat } from "../../adapter.js";

/**
 * Issue #276: makeResumable and replay created S2Stream handles that were
 * never closed. In Node each handle owns its own HTTP/2 session (created by
 * readSession), so every streaming request leaked a connection. The fix makes
 * the adapter close its handles: on claim failure, before the 202 replay
 * response, and when a streaming response body completes/errors/cancels.
 */

interface FakeRecord {
	seqNum: number;
	timestamp: Date;
	headers?: [string, string][];
	body?: string;
}

const dataRecord = (seqNum: number, body: string): FakeRecord => ({
	seqNum,
	timestamp: new Date(),
	headers: [],
	body,
});

const fenceRecord = (seqNum: number, token: string): FakeRecord => ({
	seqNum,
	timestamp: new Date(),
	headers: [["", "fence"]],
	body: token,
});

class FakeStreamHandle {
	closed = false;
	constructor(private records: FakeRecord[]) {}

	async readSession(args: any, _opts: any) {
		const from: number = args?.start?.from?.seqNum ?? 0;
		const records = this.records.filter((r) => r.seqNum >= from);
		return {
			async *[Symbol.asyncIterator]() {
				for (const record of records) yield record;
			},
			[Symbol.asyncDispose]: async () => {},
		};
	}

	async read(_args: any, _opts: any) {
		return { records: this.records };
	}

	async append(_input: any) {
		const timestamp = new Date();
		return {
			start: { seqNum: 0, timestamp },
			end: { seqNum: 1, timestamp },
			tail: { seqNum: 1, timestamp },
		};
	}

	async close() {
		this.closed = true;
	}
}

class FakeS2 {
	handles: FakeStreamHandle[] = [];
	constructor(private makeRecords: () => FakeRecord[]) {}

	basin(_name: string) {
		return {
			stream: (_stream: string) => {
				const handle = new FakeStreamHandle(this.makeRecords());
				this.handles.push(handle);
				return handle;
			},
		};
	}
}

const adapter: ChatAdapter<string> = {
	makeErrorChunk: () => "error",
	responseHeaders: { "Content-Type": "text/event-stream" },
};

const config = { accessToken: "token", basin: "basin" };
const swallow = (promise: Promise<unknown>) => {
	promise.catch(() => {});
};

describe("Issue #276: adapter closes stream handles", () => {
	it("replay: closes the handle after the SSE body is fully consumed", async () => {
		const s2 = new FakeS2(() => [
			fenceRecord(0, "session-live"),
			dataRecord(1, "hello"),
		]);
		const chat = createChat(config, adapter, s2 as any);

		const response = await chat.replay("stream-1");
		const body = await response.text();

		expect(body).toContain("hello");
		expect(s2.handles).toHaveLength(1);
		expect(s2.handles[0]!.closed).toBe(true);
	});

	it("replay: closes the handle on the 204 empty-replay path", async () => {
		const s2 = new FakeS2(() => []);
		const chat = createChat(config, adapter, s2 as any);

		const response = await chat.replay("stream-1");

		expect(response.status).toBe(204);
		expect(s2.handles[0]!.closed).toBe(true);
	});

	it("replay: closes the handle when the client cancels mid-stream", async () => {
		const s2 = new FakeS2(() => [
			dataRecord(0, "a"),
			dataRecord(1, "b"),
			dataRecord(2, "c"),
		]);
		const chat = createChat({ ...config, mode: "session" }, adapter, s2 as any);

		const response = await chat.replay("stream-1", { live: true });
		const reader = response.body!.getReader();
		await reader.read();
		await reader.cancel();

		expect(s2.handles[0]!.closed).toBe(true);
	});

	it("makeResumable: closes the claim handle when the stream is in use", async () => {
		// Session claim: a non-fence last record means an active generation.
		const s2 = new FakeS2(() => [dataRecord(0, "busy")]);
		const chat = createChat({ ...config, mode: "session" }, adapter, s2 as any);

		const response = await chat.makeResumable(
			"stream-1",
			(async function* () {})(),
			{ waitUntil: swallow },
		);

		expect(response.status).toBe(409);
		expect(s2.handles[0]!.closed).toBe(true);
	});

	it("makeResumable: closes the claim handle before returning 202 on replay delivery", async () => {
		const s2 = new FakeS2(() => []);
		const chat = createChat(config, adapter, s2 as any);

		const response = await chat.makeResumable(
			"stream-1",
			(async function* () {})(),
			{ waitUntil: swallow, delivery: "replay" },
		);

		expect(response.status).toBe(202);
		expect(s2.handles[0]!.closed).toBe(true);
	});

	it("makeResumable: closes the streaming handle after the response completes", async () => {
		// Tail from seqNum 1: one data record, then a fence stops the tail.
		const s2 = new FakeS2(() => [
			dataRecord(1, "chunk"),
			fenceRecord(2, "next-gen"),
		]);
		const chat = createChat(config, adapter, s2 as any);

		const response = await chat.makeResumable(
			"stream-1",
			(async function* () {})(),
			{ waitUntil: swallow },
		);
		const body = await response.text();

		expect(body).toContain("chunk");
		// One handle for claim + tail (reused), one created by persistToS2.
		const adapterHandle = s2.handles[0]!;
		expect(adapterHandle.closed).toBe(true);
	});
});
