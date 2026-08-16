import { describe, expect, it, vi } from "vitest";
import type { Client } from "../generated/client/index.js";
import { streamAppend } from "../lib/stream/transport/fetch/shared.js";
import type { AppendInput, AppendRecord } from "../types.js";

const mocks = vi.hoisted(() => ({
	append: vi.fn(),
	protoLoads: 0,
}));

vi.mock("../generated/index.js", () => ({
	append: mocks.append,
	read: vi.fn(),
}));

vi.mock("../lib/stream/transport/proto.js", () => {
	mocks.protoLoads += 1;
	return {
		decodeProtoAppendAck: vi.fn(() => ({})),
		decodeProtoReadBatch: vi.fn(),
		encodeProtoAppendInput: vi.fn(() => new Uint8Array()),
		protoAppendAckToJson: vi.fn(() => ({
			start: { seqNum: 0, timestamp: new Date(0) },
			end: { seqNum: 1, timestamp: new Date(0) },
			tail: { seqNum: 1, timestamp: new Date(0) },
		})),
	};
});

const client = {} as Client;

const input = (record: AppendRecord): AppendInput => ({
	records: [record],
	meteredBytes: record.meteredBytes,
});

describe("lazy protobuf codec", () => {
	it("loads protobuf only when a binary operation needs it", async () => {
		mocks.append.mockResolvedValueOnce({
			data: {
				start: { seq_num: 0, timestamp: 0 },
				end: { seq_num: 1, timestamp: 0 },
				tail: { seq_num: 1, timestamp: 0 },
			},
			response: { ok: true },
		});

		expect(mocks.protoLoads).toBe(0);
		await streamAppend(
			"test-stream",
			client,
			input({ body: "text", meteredBytes: 12 }),
		);
		expect(mocks.protoLoads).toBe(0);

		mocks.append.mockResolvedValueOnce({
			data: new ArrayBuffer(0),
			response: { ok: true },
		});

		await streamAppend(
			"test-stream",
			client,
			input({ body: new Uint8Array([1]), meteredBytes: 9 }),
		);
		expect(mocks.protoLoads).toBe(1);
	});
});
