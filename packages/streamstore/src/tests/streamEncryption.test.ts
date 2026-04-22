import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/stream/factory.js", () => ({
	createSessionTransport: vi.fn(),
}));

vi.mock("../lib/stream/transport/fetch/shared.js", () => ({
	streamAppend: vi.fn(),
	streamRead: vi.fn(),
}));

import { S2Basin } from "../basin.js";
import * as Redacted from "../lib/redacted.js";
import { createSessionTransport } from "../lib/stream/factory.js";
import * as SharedTransport from "../lib/stream/transport/fetch/shared.js";
import { S2Stream } from "../stream.js";
import { AppendInput, AppendRecord, EncryptionKey } from "../types.js";

const KEY_B64 = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=";
const KEY_BYTES = new Uint8Array([1, 2, 3, 4]);

const makeStream = () =>
	new S2Stream("events", {} as any, {
		baseUrl: "https://demo-basin.b.s2.dev/v1",
		accessToken: Redacted.make("token"),
	});

describe("Stream encryption", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("adds the encryption header to unary append and read requests", async () => {
		vi.mocked(SharedTransport.streamAppend).mockResolvedValue({
			start: { seqNum: 0, timestamp: new Date(0) },
			end: { seqNum: 0, timestamp: new Date(0) },
			tail: { seqNum: 0, timestamp: new Date(0) },
		});
		vi.mocked(SharedTransport.streamRead).mockResolvedValue({
			records: [],
		});

		const stream = makeStream().withEncryptionKey(` ${KEY_B64}\n`);

		await stream.append(
			AppendInput.create([AppendRecord.string({ body: "a" })]),
		);
		await stream.read();

		expect(
			(vi.mocked(SharedTransport.streamAppend).mock.calls[0]?.[3] as any)
				?.headers,
		).toEqual({
			"s2-encryption-key": KEY_B64,
		});
		expect(
			(vi.mocked(SharedTransport.streamRead).mock.calls[0]?.[3] as any)
				?.headers,
		).toEqual({
			"s2-encryption-key": KEY_B64,
		});
	});

	it("normalizes basin.stream encryptionKey options before creating a session transport", async () => {
		vi.mocked(createSessionTransport).mockResolvedValue({
			makeAppendSession: vi.fn(),
			makeReadSession: vi.fn().mockResolvedValue({}),
			close: vi.fn(),
		} as any);

		const basin = new S2Basin("demo-basin", {
			accessToken: Redacted.make("token"),
			baseUrl: "https://demo-basin.b.s2.dev/v1",
			includeBasinHeader: false,
		});

		const stream = basin.stream("events", { encryptionKey: KEY_BYTES });
		await stream.readSession();

		const transportConfig = vi.mocked(createSessionTransport).mock
			.calls[0]?.[0];
		expect(transportConfig?.encryptionKey).toBeDefined();
		expect(Redacted.value(transportConfig!.encryptionKey!)).toBe(
			EncryptionKey.from(KEY_BYTES),
		);
	});
});
