import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/stream/factory.js", () => ({
	createSessionTransport: vi.fn(),
}));

vi.mock("../lib/stream/transport/fetch/shared.js", () => ({
	streamAppend: vi.fn(),
	streamRead: vi.fn(),
}));

import * as Redacted from "../lib/redacted.js";
import { createSessionTransport } from "../lib/stream/factory.js";
import * as SharedTransport from "../lib/stream/transport/fetch/shared.js";
import {
	S2_STREAM_CONFIG_HEADER,
	streamConfigHeaderValue,
} from "../lib/stream-config.js";
import { S2Stream } from "../stream.js";
import { AppendInput, AppendRecord, type StreamConfig } from "../types.js";

const KEY_B64 = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=";

const streamConfig: StreamConfig = {
	retentionPolicy: { ageSecs: 3600 },
	deleteOnEmpty: { minAgeSecs: 300 },
	storageClass: "express",
};

const expectedHeader = JSON.stringify({
	retention_policy: { age: 3600 },
	delete_on_empty: { min_age_secs: 300 },
	storage_class: "express",
});

const makeStream = () =>
	new S2Stream("events", {} as any, {
		baseUrl: "https://demo-basin.b.s2.dev/v1",
		accessToken: Redacted.make("token"),
	});

const ack = {
	start: { seqNum: 0, timestamp: new Date(0) },
	end: { seqNum: 0, timestamp: new Date(0) },
	tail: { seqNum: 0, timestamp: new Date(0) },
};

describe("s2-stream-config header", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("encodes the config in API wire format", () => {
		expect(JSON.parse(streamConfigHeaderValue(streamConfig))).toEqual(
			JSON.parse(expectedHeader),
		);
		expect(
			JSON.parse(
				streamConfigHeaderValue({
					retentionPolicy: { infinite: {} },
					timestamping: { mode: "client-require", uncapped: true },
				}),
			),
		).toEqual({
			retention_policy: { infinite: {} },
			timestamping: { mode: "client-require", uncapped: true },
		});
	});

	it("is sent on unary append and read alongside the encryption header", async () => {
		vi.mocked(SharedTransport.streamAppend).mockResolvedValue(ack);
		vi.mocked(SharedTransport.streamRead).mockResolvedValue({ records: [] });

		const stream = makeStream().withEncryptionKey(KEY_B64);
		await stream.append(
			AppendInput.create([AppendRecord.string({ body: "a" })], {
				streamConfig,
			}),
		);
		await stream.read({ streamConfig });

		const appendOptions = vi.mocked(SharedTransport.streamAppend).mock
			.calls[0]?.[3] as any;
		expect(appendOptions?.headers).toEqual({
			"s2-encryption-key": KEY_B64,
			[S2_STREAM_CONFIG_HEADER]: expectedHeader,
		});

		const [, , readArgs, readOptions] = vi.mocked(SharedTransport.streamRead)
			.mock.calls[0] as any[];
		expect(readOptions?.headers).toEqual({
			"s2-encryption-key": KEY_B64,
			[S2_STREAM_CONFIG_HEADER]: expectedHeader,
		});
		expect(readArgs).not.toHaveProperty("stream_config");
	});

	it("is omitted when no config is given", async () => {
		vi.mocked(SharedTransport.streamAppend).mockResolvedValue(ack);
		vi.mocked(SharedTransport.streamRead).mockResolvedValue({ records: [] });

		const stream = makeStream();
		await stream.append(
			AppendInput.create([AppendRecord.string({ body: "a" })]),
		);
		await stream.read();

		expect(
			(vi.mocked(SharedTransport.streamAppend).mock.calls[0]?.[3] as any)
				?.headers,
		).toBeUndefined();
		expect(
			(vi.mocked(SharedTransport.streamRead).mock.calls[0]?.[3] as any)
				?.headers,
		).toBeUndefined();
	});

	it("reaches the session transport for append and read sessions", async () => {
		const makeAppendSession = vi.fn().mockResolvedValue({});
		const makeReadSession = vi.fn().mockResolvedValue({});
		vi.mocked(createSessionTransport).mockResolvedValue({
			makeAppendSession,
			makeReadSession,
			close: vi.fn(),
		} as any);

		const stream = makeStream();
		await stream.appendSession({ maxInflightBatches: 2, streamConfig });
		await stream.readSession({
			start: { from: { seqNum: 7 } },
			streamConfig,
		});

		expect(makeAppendSession).toHaveBeenCalledWith(
			"events",
			{ maxInflightBatches: 2, streamConfig },
			undefined,
		);
		expect(makeReadSession.mock.calls[0]?.[1]).toMatchObject({
			seq_num: 7,
			stream_config: streamConfig,
		});
	});
});
